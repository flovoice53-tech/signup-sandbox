// HTTP API + web UI. Runs are kept in memory and written to DATA_DIR as
// JSON when they finish, so the history survives a restart.
import http from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, decideApproval, executeRun, MAX_RUN_MS, newRunId, type Run, type RunEvent } from "./agent.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DEMO_URL, demoEmailsLeft, startDemoSites } from "./demo-sites.ts";
import { cleanupStale, DRIVER, startJanitor } from "./sandbox.ts";
import { MODEL } from "./llm.ts";
import { UI_HTML } from "./ui.ts";
import { listMonitors, startMonitors } from "./monitors.ts";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 3);
const RUNS_PER_IP_PER_HOUR = Number(process.env.RUNS_PER_IP_PER_HOUR ?? 6);
// Every run costs model tokens and a demo email, so the public demo has a daily ceiling.
const RUNS_PER_DAY = Number(process.env.RUNS_PER_DAY ?? 150);
const MAX_BODY_BYTES = 8 * 1024;

export const TARGETS: Record<string, { label: string; description: string }> = {
  acme: { label: "Working signup", description: "Form, emailed 6-digit code, welcome page." },
  broken: { label: "Broken verification link", description: "The emailed link returns a server error." },
  trap: { label: "Hostile page", description: "Hidden prompt injection, form exfiltration and a cloud-metadata grab." },
  compromised: {
    label: "Compromised agent (red team)",
    description: "Same hostile page. The model is told to trust it; if it refuses, a fully compromised agent is simulated. Policy off: only the sandbox is left.",
  },
};

const runs = new Map<string, Run>();
const approvalTokens = new Map<string, string>();
// Benchmark canary: requests that reach it came from outside the sandbox.
const canaryHits = new Map<string, number>();
const hitCanary = (token: string) => {
  if (canaryHits.size > 5000) canaryHits.clear();
  canaryHits.set(token, (canaryHits.get(token) ?? 0) + 1);
};
const listeners = new Map<string, Set<http.ServerResponse>>();
const recentByIp = new Map<string, number[]>();
let runDay = "";
let runsToday = 0;

setInterval(() => {
  const hourAgo = Date.now() - 3600_000;
  for (const [key, times] of recentByIp) {
    const kept = times.filter((t) => t > hourAgo);
    if (kept.length) recentByIp.set(key, kept);
    else recentByIp.delete(key);
  }
}, 10 * 60_000).unref();

async function loadHistory() {
  if (!existsSync(DATA_DIR)) return;
  for (const id of await readdir(DATA_DIR)) {
    try {
      const run = JSON.parse(await readFile(path.join(DATA_DIR, id, "run.json"), "utf8")) as Run;
      runs.set(run.id, run);
    } catch {
      // run without run.json (crashed mid-way): skip
    }
  }
}

function emitFor(run: Run) {
  return (event: RunEvent) => {
    run.events.push(event);
    for (const res of listeners.get(run.id) ?? []) res.write(`data: ${JSON.stringify({ event, run: summary(run) })}\n\n`);
  };
}

function summary(run: Run) {
  const { events, ...rest } = run;
  return rest;
}

// Caddy appends the real client address as the last X-Forwarded-For entry.
function clientIp(req: http.IncomingMessage) {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",").pop()?.trim() || req.socket.remoteAddress || "";
}

// IPv6 users usually control a whole /64, so that is the unit we limit.
function rateKey(ip: string) {
  if (!ip.includes(":") || ip.startsWith("::ffff:")) return ip.replace(/^::ffff:/, "");
  const groups = ip.split("::")[0].split(":");
  return groups.slice(0, 4).join(":") + "::/64";
}

async function readBody(req: http.IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error("body too large");
  }
  return raw;
}

// The run judge mode replays when no sandbox is free: FEATURED_RUN if set,
// otherwise the latest red-team run where the sandbox stopped every attempt.
function featuredRun() {
  const pinned = process.env.FEATURED_RUN && runs.get(process.env.FEATURED_RUN);
  if (pinned) return pinned;
  return [...runs.values()]
    .filter((r) => r.compromised && r.status === "passed" && r.redTeamAttempts && r.redTeamStopped === r.redTeamAttempts)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

const isDemoRun = (run: Run) => run.targetUrl.startsWith(`${DEMO_URL}/`);

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function startRun(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: { target?: string; url?: string; token?: string; approval?: boolean } = {};
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return json(res, 400, { error: "invalid request body" });
  }

  let targetUrl: string;
  let compromised = false;
  if (body.target && TARGETS[body.target]) {
    compromised = body.target === "compromised";
    targetUrl = `${DEMO_URL}/${compromised || body.target === "trap" ? "notes" : body.target}`;
  } else if (body.url && process.env.RUN_TOKEN && body.token === process.env.RUN_TOKEN) {
    // Custom URLs only for the operator: the public demo can't be pointed at other people's sites.
    try {
      const u = new URL(body.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      targetUrl = u.toString();
    } catch {
      return json(res, 400, { error: "invalid url" });
    }
  } else {
    return json(res, 400, { error: `target must be one of: ${Object.keys(TARGETS).join(", ")}` });
  }

  const key = rateKey(clientIp(req));
  const hourAgo = Date.now() - 3600_000;
  const recent = (recentByIp.get(key) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= RUNS_PER_IP_PER_HOUR) return json(res, 429, { error: "Too many runs from your network; try again later, or watch a recent run below." });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== runDay) {
    runDay = today;
    runsToday = 0;
  }
  if (runsToday >= RUNS_PER_DAY) return json(res, 429, { error: "The demo has reached today's run limit; watch a recent run below." });
  // Without an email the demo site can't verify, and the verdict would wrongly say the flow is broken.
  const busy = capacityError(targetUrl, body.approval === true && !compromised);
  if (busy) return json(res, /busy|waiting/.test(busy) ? 503 : 429, { error: busy });
  recent.push(Date.now());
  recentByIp.set(key, recent);
  runsToday++;

  const { run } = launch(targetUrl, { compromised, approval: body.approval === true && !compromised });
  // Only whoever started the run can approve its actions.
  const approvalToken = run.approval ? randomBytes(16).toString("hex") : undefined;
  if (approvalToken) approvalTokens.set(run.id, approvalToken);
  json(res, 201, { id: run.id, approvalToken });
}

// Can a demo run start right now? Shared by visitors and the monitors.
function capacityError(targetUrl: string, approval = false) {
  const running = [...runs.values()].filter((r) => r.status === "running");
  const active = running.length;
  // A run waiting for a person holds a sandbox; keep that to one at a time.
  if (approval && running.some((r) => r.approval)) return "Another human-in-the-loop run is waiting for approval; try again in a minute, or untick the option.";
  if (targetUrl.startsWith(`${DEMO_URL}/`) && demoEmailsLeft() - active <= 0) return "The demo has used today's email budget; watch a recent run below.";
  if (active >= MAX_CONCURRENT) return "All sandboxes are busy; try again in a minute, or watch a recent run below.";
  return null;
}

function launch(targetUrl: string, opts: { compromised?: boolean; approval?: boolean; monitor?: string }) {
  const run: Run = {
    id: newRunId(),
    targetUrl,
    compromised: !!opts.compromised,
    status: "running",
    startedAt: new Date().toISOString(),
    steps: 0,
    blockedRequests: 0,
    usage: { promptTokens: 0, completionTokens: 0 },
    events: [],
    approval: !!opts.approval,
    monitor: opts.monitor,
  };
  runs.set(run.id, run);
  const done = executeRun(run, emitFor(run)).finally(async () => {
    approvalTokens.delete(run.id);
    await writeFile(path.join(DATA_DIR, run.id, "run.json"), JSON.stringify(run)).catch(() => {});
    // Sent after teardown, so viewers see "Sandbox destroyed" before the stream closes.
    for (const l of listeners.get(run.id) ?? []) l.end(`data: ${JSON.stringify({ run: summary(run), end: true })}\n\n`);
    listeners.delete(run.id);
  });
  return { run, done };
}

function streamEvents(run: Run, req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  for (const event of run.events) res.write(`data: ${JSON.stringify({ event, run: summary(run) })}\n\n`);
  if (run.status !== "running") {
    return res.end(`data: ${JSON.stringify({ run: summary(run), end: true })}\n\n`);
  }
  const set = listeners.get(run.id) ?? new Set();
  set.add(res);
  listeners.set(run.id, set);
  // Keeps proxies from closing the stream during the long email wait.
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && parts.length === 0) {
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(UI_HTML);
    }
    if (parts[0] === "canary" && parts[1]) {
      hitCanary(parts[1]);
      req.resume();
      return res.writeHead(204).end();
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "canary" && parts[2]) {
      return json(res, 200, { hits: canaryHits.get(parts[2]) ?? 0 });
    }
    if (req.method === "GET" && url.pathname === "/api/monitors") {
      return json(res, 200, listMonitors().map(({ alerts, ...m }) => ({ ...m, alerts: alerts.map(({ at, channels, text }) => ({ at, channels, text })) })));
    }
    if (req.method === "GET" && url.pathname === "/api/bench") {
      try {
        return json(res, 200, JSON.parse(await readFile(path.join(DATA_DIR, "bench.json"), "utf8")));
      } catch {
        return json(res, 404, { error: "no benchmark yet" });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, { targets: TARGETS, driver: DRIVER, model: MODEL, demoUrl: DEMO_URL, featured: featuredRun()?.id ?? null });
    }
    if (url.pathname === "/api/runs" && req.method === "POST") return startRun(req, res);
    if (url.pathname === "/api/runs" && req.method === "GET") {
      // Only demo runs are listed; operator runs against other sites stay out of the public history.
      const list = [...runs.values()]
        .filter(isDemoRun)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20)
        .map(summary);
      return json(res, 200, list);
    }
    if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
      const run = runs.get(parts[2]);
      if (!run) return json(res, 404, { error: "not found" });
      if (parts.length === 3) return json(res, 200, run);
      if (parts[3] === "events") return streamEvents(run, req, res);
      if (parts[3] === "approve" && req.method === "POST") {
        let body: { token?: string; approve?: boolean } = {};
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return json(res, 400, { error: "invalid request body" });
        }
        const expected = approvalTokens.get(run.id);
        const given = Buffer.from(String(body.token ?? ""));
        if (!expected || given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected))) return json(res, 403, { error: "not allowed" });
        if (!decideApproval(run.id, body.approve === true)) return json(res, 409, { error: "nothing is waiting for approval" });
        return json(res, 200, { ok: true });
      }
      if (parts[3] === "shots" && /^step-\d+\.jpg$/.test(parts[4] ?? "")) {
        const file = path.join(DATA_DIR, run.id, parts[4]);
        if (!existsSync(file)) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" });
        return createReadStream(file).pipe(res);
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

// A WebSocket that reaches the canary counts too.
server.on("upgrade", (req, socket) => {
  const parts = new URL(req.url ?? "/", "http://x").pathname.split("/").filter(Boolean);
  if (parts[0] === "canary" && parts[1]) hitCanary(parts[1]);
  socket.destroy();
});

await cleanupStale();
startJanitor(MAX_RUN_MS + 2 * 60_000, (name) => runs.get(name.replace(/^sbx-/, ""))?.status === "running");
await loadHistory();
startDemoSites();
await startMonitors((target, monitor) => {
  const targetUrl = `${DEMO_URL}/${target === "trap" ? "notes" : target}`;
  const busy = capacityError(targetUrl);
  return busy ? { error: busy } : launch(targetUrl, { monitor });
}, Object.keys(TARGETS).filter((t) => t !== "compromised"));
// Loopback only: Caddy is the public entry, and sandbox containers must not
// be able to reach these ports directly.
server.listen(PORT, process.env.HOST ?? "127.0.0.1", () => console.log(`signup-sandbox on http://localhost:${PORT} (driver: ${DRIVER}, model: ${MODEL || "unset"})`));
