// Scheduled monitors: run a signup flow on an interval and alert only when
// its verdict changes (works → broken, or broken → fixed).
//   MONITORS="acme:360,broken:360"   target:minutes, demo targets only
//   ALERT_EMAIL=you@example.com      optional, one email per change
//   ALERT_WEBHOOK=https://…          optional, JSON {text, …} (Slack-compatible)
// State survives restarts in DATA_DIR/monitors.json.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, type Run } from "./agent.ts";
import { sendAlertMail } from "./demo-sites.ts";

export type MonitorResult = { at: string; status: Run["status"]; runId: string };
export type MonitorState = {
  name: string;
  target: string;
  everyMinutes: number;
  last?: MonitorResult;
  history: MonitorResult[];
  alerts: { at: string; text: string; channels: string[] }[];
  nextAt?: string;
};

type Launch = (target: string, monitor: string) => { run: Run; done: Promise<void> } | { error: string };

const FILE = path.join(DATA_DIR, "monitors.json");
const RETRY_MS = 5 * 60_000;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const monitors = new Map<string, MonitorState>();

export const listMonitors = () => [...monitors.values()];

async function save() {
  await writeFile(FILE, JSON.stringify(listMonitors(), null, 2)).catch(() => {});
}

async function alert(m: MonitorState, prev: MonitorResult | undefined, run: Run) {
  const works = run.status === "passed";
  const link = PUBLIC_URL ? `${PUBLIC_URL}/?run=${run.id}` : run.id;
  const subject = works
    ? prev ? `Fixed: signup flow "${m.name}" works again` : `Monitoring started: signup flow "${m.name}" works`
    : `Broken: signup flow "${m.name}" failed`;
  const text = `${subject}${prev ? ` (was ${prev.status})` : ""}. ${run.summary ?? ""} Run: ${link}`;
  const channels: string[] = [];
  if (process.env.ALERT_EMAIL) {
    await sendAlertMail(process.env.ALERT_EMAIL, subject, text)
      .then(() => channels.push("email"))
      .catch((err) => console.error("monitor alert email failed:", (err as Error).message));
  }
  if (process.env.ALERT_WEBHOOK) {
    await fetch(process.env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, monitor: m.name, status: run.status, runId: run.id, url: link }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.ok && channels.push("webhook"))
      .catch((err) => console.error("monitor webhook failed:", (err as Error).message));
  }
  m.alerts.unshift({ at: new Date().toISOString(), text, channels });
  m.alerts = m.alerts.slice(0, 20);
}

async function tick(m: MonitorState, launch: Launch) {
  const started = launch(m.target, m.name);
  if ("error" in started) {
    // Busy or out of budget: try again soon instead of skipping a whole interval.
    schedule(m, launch, RETRY_MS);
    return;
  }
  schedule(m, launch, m.everyMinutes * 60_000);
  await started.done;
  const run = started.run;
  // A run that errored (model or sandbox trouble) says nothing about the site.
  if (run.status === "error" || run.status === "running") return void (await save());
  const result: MonitorResult = { at: run.finishedAt ?? new Date().toISOString(), status: run.status, runId: run.id };
  const prev = m.last;
  m.last = result;
  m.history.unshift(result);
  m.history = m.history.slice(0, 48);
  if (!prev || prev.status !== result.status) await alert(m, prev, run);
  await save();
}

const timers = new Map<string, NodeJS.Timeout>();
function schedule(m: MonitorState, launch: Launch, inMs: number) {
  clearTimeout(timers.get(m.name));
  m.nextAt = new Date(Date.now() + inMs).toISOString();
  timers.set(m.name, setTimeout(() => void tick(m, launch).catch((err) => console.error("monitor", m.name, err)), inMs).unref());
}

export async function startMonitors(launch: Launch, targets: string[]) {
  const spec = (process.env.MONITORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!spec.length) return;
  let saved: MonitorState[] = [];
  try {
    saved = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    // first start
  }
  spec.forEach((entry, i) => {
    const [target, minutes] = entry.split(":");
    if (!targets.includes(target)) return console.error(`MONITORS: unknown target ${target}`);
    const everyMinutes = Math.max(15, Number(minutes) || 360);
    const old = saved.find((s) => s.name === target);
    const m: MonitorState = { name: target, target, everyMinutes, history: old?.history ?? [], alerts: old?.alerts ?? [], last: old?.last };
    monitors.set(m.name, m);
    // Resume the schedule after a restart; stagger first runs so they don't compete.
    const due = old?.last ? Date.parse(old.last.at) + everyMinutes * 60_000 - Date.now() : 0;
    schedule(m, launch, Math.max(due, 60_000 * (i + 1)));
  });
}
