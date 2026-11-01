// HTTP API + web UI. Runs are kept in memory and written to DATA_DIR as
// JSON when they finish, so the history survives a restart.
import http from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, executeRun, newRunId, type Run, type RunEvent } from "./agent.ts";
import { DEMO_URL, startDemoSites } from "./demo-sites.ts";
import { cleanupStale, DRIVER } from "./sandbox.ts";
import { MODEL } from "./llm.ts";
import { UI_HTML } from "./ui.ts";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 2);
const RUNS_PER_IP_PER_HOUR = Number(process.env.RUNS_PER_IP_PER_HOUR ?? 6);

export const TARGETS: Record<string, { label: string; description: string }> = {
  acme: { label: "Working signup", description: "Form, emailed 6-digit code, welcome page." },
  broken: { label: "Broken verification link", description: "The emailed link returns a server error." },
  trap: { label: "Hostile page", description: "Hidden prompt injection, form exfiltration and a cloud-metadata grab." },
};

const runs = new Map<string, Run>();
const listeners = new Map<string, Set<http.ServerResponse>>();
const recentByIp = new Map<string, number[]>();

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

function clientIp(req: http.IncomingMessage) {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() || req.socket.remoteAddress || "";
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function startRun(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: { target?: string; url?: string; token?: string } = {};
  try {
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw || "{}");
  } catch {
    return json(res, 400, { error: "invalid JSON" });
  }

  let targetUrl: string;
  if (body.target && TARGETS[body.target]) {
    targetUrl = `${DEMO_URL}/${body.target}`;
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

  const ip = clientIp(req);
  const hourAgo = Date.now() - 3600_000;
  const recent = (recentByIp.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= RUNS_PER_IP_PER_HOUR) return json(res, 429, { error: "Too many runs from your address; try again later." });
  const active = [...runs.values()].filter((r) => r.status === "running").length;
  if (active >= MAX_CONCURRENT) return json(res, 503, { error: "All sandboxes are busy; try again in a minute." });
  recent.push(Date.now());
  recentByIp.set(ip, recent);

  const run: Run = {
    id: newRunId(),
    targetUrl,
    status: "running",
    startedAt: new Date().toISOString(),
    steps: 0,
    blockedRequests: 0,
    usage: { promptTokens: 0, completionTokens: 0 },
    events: [],
  };
  runs.set(run.id, run);
  executeRun(run, emitFor(run)).finally(async () => {
    await writeFile(path.join(DATA_DIR, run.id, "run.json"), JSON.stringify(run)).catch(() => {});
    for (const l of listeners.get(run.id) ?? []) l.end();
    listeners.delete(run.id);
  });
  json(res, 201, { id: run.id });
}

function streamEvents(run: Run, req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  for (const event of run.events) res.write(`data: ${JSON.stringify({ event, run: summary(run) })}\n\n`);
  if (run.status !== "running") {
    res.write(`data: ${JSON.stringify({ run: summary(run) })}\n\n`);
    return res.end();
  }
  const set = listeners.get(run.id) ?? new Set();
  set.add(res);
  listeners.set(run.id, set);
  req.on("close", () => set.delete(res));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && parts.length === 0) {
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(UI_HTML);
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, { targets: TARGETS, driver: DRIVER, model: MODEL, demoUrl: DEMO_URL });
    }
    if (url.pathname === "/api/runs" && req.method === "POST") return startRun(req, res);
    if (url.pathname === "/api/runs" && req.method === "GET") {
      const list = [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20).map(summary);
      return json(res, 200, list);
    }
    if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
      const run = runs.get(parts[2]);
      if (!run) return json(res, 404, { error: "not found" });
      if (parts.length === 3) return json(res, 200, run);
      if (parts[3] === "events") return streamEvents(run, req, res);
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

await cleanupStale();
await loadHistory();
startDemoSites();
// Loopback only: Caddy is the public entry, and sandbox containers must not
// be able to reach these ports directly.
server.listen(PORT, process.env.HOST ?? "127.0.0.1", () => console.log(`signup-sandbox on http://localhost:${PORT} (driver: ${DRIVER}, model: ${MODEL || "unset"})`));
