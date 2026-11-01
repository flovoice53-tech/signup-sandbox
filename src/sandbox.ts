// One sandbox per run: an egress proxy that only lets the target host
// through, and a browser that can reach nothing but that proxy. Both are
// thrown away when the run ends.
//
// SANDBOX_DRIVER=docker (production): a per-run --internal Docker network,
// the proxy container bridging it to the shared egress network, and a
// locked-down browser container (no capabilities, read-only filesystem,
// memory/CPU/process limits, no secrets in its environment).
// SANDBOX_DRIVER=local (development only): the same proxy and runner as
// plain child processes. Same egress policy, but no OS-level isolation.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DRIVER = process.env.SANDBOX_DRIVER === "docker" ? "docker" : "local";
const EGRESS_NETWORK = "sbx-egress";

export type ProxyEvent = { type: "ready" | "allowed" | "blocked"; host?: string; port?: number; method?: string; path?: string; reason?: string; at: string };

export const LIMITS = {
  memory: "1g",
  cpus: "1",
  pids: 512,
  commandTimeoutMs: 30_000,
};

const docker = (...args: string[]) => run("docker", args, { timeout: 30_000 });

// Removes anything a crashed process left behind; called once at startup.
export async function cleanupStale() {
  if (DRIVER !== "docker") return;
  const { stdout: ids } = await docker("ps", "-aq", "--filter", "label=sbx=1");
  if (ids.trim()) await docker("rm", "-f", ...ids.trim().split("\n"));
  const { stdout: nets } = await docker("network", "ls", "-q", "--filter", "label=sbx=run");
  if (nets.trim()) await docker("network", "rm", ...nets.trim().split("\n"));
  await docker("network", "inspect", EGRESS_NETWORK).catch(() =>
    docker("network", "create", "--label", "sbx=egress", EGRESS_NETWORK),
  );
}

function lines(child: ChildProcess, onLine: (value: any) => void) {
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      onLine(JSON.parse(line));
    } catch {
      // not ours (e.g. a library warning)
    }
  });
}

export class Sandbox {
  private browser!: ChildProcess;
  private proxy!: ChildProcess;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stopped = false;
  readonly name: string;

  private constructor(runId: string, private onProxyEvent: (e: ProxyEvent) => void) {
    this.name = `sbx-${runId}`;
  }

  static async start(runId: string, allowHosts: string[], onProxyEvent: (e: ProxyEvent) => void) {
    const sandbox = new Sandbox(runId, onProxyEvent);
    try {
      await (DRIVER === "docker" ? sandbox.startDocker(allowHosts) : sandbox.startLocal(allowHosts));
    } catch (err) {
      await sandbox.stop();
      throw err;
    }
    return sandbox;
  }

  private async startDocker(allowHosts: string[]) {
    const net = this.name;
    const proxyName = `${this.name}-proxy`;
    await docker("network", "create", "--internal", "--label", "sbx=run", net);
    await docker(
      "run", "-d", "--name", proxyName, "--label", "sbx=1",
      "--network", EGRESS_NETWORK,
      "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", `ALLOW_HOSTS=${allowHosts.join(",")}`,
      "signup-sandbox-proxy",
    );
    await docker("network", "connect", net, proxyName);
    this.proxy = spawn("docker", ["logs", "-f", proxyName], { stdio: ["ignore", "pipe", "ignore"] });
    lines(this.proxy, (e) => this.onProxyEvent(e));

    this.browser = spawn(
      "docker",
      [
        "run", "-i", "--rm", "--name", `${this.name}-browser`, "--label", "sbx=1",
        "--network", net,
        "--memory", LIMITS.memory, "--memory-swap", LIMITS.memory, "--cpus", LIMITS.cpus,
        "--pids-limit", String(LIMITS.pids),
        "--read-only", "--tmpfs", "/tmp:size=256m", "--shm-size", "256m",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-e", "HOME=/tmp",
        "-e", `PROXY_URL=http://${proxyName}:3128`,
        "signup-sandbox-browser",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    await this.attachRunner();
  }

  private async startLocal(allowHosts: string[]) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    this.proxy = spawn(process.execPath, [path.join(root, "proxy/proxy.mjs")], {
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        ALLOW_HOSTS: allowHosts.join(","),
        // The demo sites run on this machine's loopback in development.
        ALLOW_PRIVATE: "1",
        DEV_PORT: process.env.DEMO_PORT ?? "4100",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ready = new Promise<void>((resolve) =>
      lines(this.proxy, (e) => {
        if (e.type === "ready") resolve();
        this.onProxyEvent(e);
      }),
    );
    await ready;
    // Only PATH and the proxy address: the runner never sees our keys.
    this.browser = spawn(process.execPath, [path.join(root, "sandbox/runner.mjs")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PROXY_URL: `http://127.0.0.1:${port}` },
      stdio: ["pipe", "pipe", "ignore"],
    });
    await this.attachRunner();
  }

  private attachRunner() {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sandbox browser did not start")), 60_000);
      lines(this.browser, (msg) => {
        if (msg.ready) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.ok) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error));
      });
      this.browser.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("sandbox browser exited"));
        for (const w of this.pending.values()) w.reject(new Error("sandbox browser exited"));
        this.pending.clear();
      });
    });
  }

  send<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("sandbox stopped"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, LIMITS.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.browser.stdin!.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.browser?.kill("SIGKILL");
    this.proxy?.kill("SIGKILL");
    if (DRIVER === "docker") {
      await docker("rm", "-f", `${this.name}-browser`, `${this.name}-proxy`).catch(() => {});
      await docker("network", "rm", this.name).catch(() => {});
    }
  }
}
