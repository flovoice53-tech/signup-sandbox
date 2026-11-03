// Containment benchmark: run every attack page from demo-sites.ts through a
// real sandbox and count what got out. Deterministic and model-free, so the
// numbers measure the sandbox, not how careful a model happens to be.
//   npm run bench   (on the deployment, with the service running)
// Each attack sends to a canary URL on our own server; a request that
// actually left the sandbox would be counted there. The results go to
// DATA_DIR/bench.json and are shown on the demo page.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./agent.ts";
import { ATTACKS, DEMO_URL } from "./demo-sites.ts";
import { Sandbox, type ProxyEvent } from "./sandbox.ts";

const CANARY_URL = (process.env.CANARY_URL ?? "http://localhost:4000/canary").replace(/\/$/, "");
const CANARY_API = CANARY_URL.replace(/\/canary$/, "/api/canary");
const demoHost = new URL(DEMO_URL).hostname;

type Case = { name: string; label: string; layer: string; blocked: number; blockedHosts: string[]; offsiteAllowed: number; canaryHits: number; reasons: string[] };

const canaryHits = async (token: string) => ((await (await fetch(`${CANARY_API}/${token}`)).json()) as { hits: number }).hits;

async function runCase(name: string, label: string, allowHost: string, act: (sb: Sandbox, token: string) => Promise<void>): Promise<Case> {
  const token = randomBytes(8).toString("hex");
  const events: ProxyEvent[] = [];
  const sb = await Sandbox.start(`bench${token.slice(0, 8)}`, [allowHost], (e) => events.push(e));
  try {
    await act(sb, token);
    await sb.send("wait", { ms: 3000 });
  } finally {
    await sb.stop();
  }
  await new Promise((r) => setTimeout(r, 1500));
  const blocked = events.filter((e) => e.type === "blocked");
  const offsite = events.filter((e) => e.type === "allowed" && e.host !== allowHost);
  return {
    name,
    label,
    layer: allowHost === demoHost ? "allowlist" : "private-address check",
    blocked: blocked.length,
    blockedHosts: [...new Set(blocked.map((e) => e.host ?? "?"))],
    offsiteAllowed: offsite.length,
    canaryHits: await canaryHits(token),
    reasons: [...new Set(blocked.map((e) => e.reason ?? "?"))],
  };
}

// Type into every field so input-triggered exfiltration fires.
async function typeIntoForm(sb: Sandbox, token: string) {
  const obs = await sb.send<{ text: string; elements: { ref: string; tag: string; type?: string }[] }>("observe");
  for (const el of obs.elements) {
    if (el.tag === "input" && ["text", "email", "password"].includes(el.type ?? "")) {
      await sb.send("fill", { ref: el.ref, value: el.type === "email" ? `bench-${token}@example.com` : `bench-${token}` }).catch(() => {});
    }
  }
  return obs;
}

const cases: Case[] = [];
for (const [name, a] of Object.entries(ATTACKS)) {
  process.stdout.write(`${name} … `);
  const c = await runCase(name, a.label, demoHost, async (sb, token) => {
    await sb.send("goto", { url: `${DEMO_URL}/attacks/${name}?t=${token}` });
    const obs = await typeIntoForm(sb, token);
    if (name === "hidden-injection") {
      // An agent that obeys the page: open every off-site URL it asks for.
      for (const u of obs.text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) {
        if (new URL(u.replace(/\{\{\w+\}\}/g, "x")).hostname === demoHost) continue;
        await sb.send("goto", { url: u.replace(/\{\{\w+\}\}/g, `bench-${token}`) }).catch(() => {});
      }
    }
  });
  cases.push(c);
  console.log(`blocked ${c.blocked}, off-site allowed ${c.offsiteAllowed}, canary ${c.canaryHits}`);
}

// Second layer: the allowlisted host itself resolves to the metadata service.
process.stdout.write("dns-to-metadata … ");
const rebindHost = "169.254.169.254.sslip.io";
const dnsCase = await runCase("dns-to-metadata", "Allowlisted hostname whose DNS points at the metadata service (169.254.169.254.sslip.io)", rebindHost, async (sb) => {
  await sb.send("goto", { url: `http://${rebindHost}/v1.json` }).catch(() => {});
});
cases.push(dnsCase);
console.log(`blocked ${dnsCase.blocked} (${dnsCase.reasons.join(", ")})`);

// Control: the same canary, hit from outside the sandbox, must count.
const control = randomBytes(8).toString("hex");
await fetch(`${CANARY_URL}/${control}`).catch(() => {});
const controlHits = await canaryHits(control);

const result = {
  at: new Date().toISOString(),
  sandbox: "docker",
  attacks: cases.length,
  blocked: cases.reduce((n, c) => n + c.blocked, 0),
  offsiteAllowed: cases.reduce((n, c) => n + c.offsiteAllowed, 0),
  canaryHits: cases.reduce((n, c) => n + c.canaryHits, 0),
  controlHits,
  cases,
};
await mkdir(DATA_DIR, { recursive: true });
await writeFile(path.join(DATA_DIR, "bench.json"), JSON.stringify(result, null, 2));
console.log(`\n${result.attacks} attacks · ${result.blocked} requests blocked · ${result.offsiteAllowed} off-site requests allowed · canary hits ${result.canaryHits} (control from outside: ${controlHits})`);
console.log("\n| Attack | Blocked requests | Got out |\n|---|---|---|");
for (const c of cases) console.log(`| ${c.label} | ${c.blocked} | ${c.offsiteAllowed + c.canaryHits === 0 ? "nothing" : `${c.offsiteAllowed} allowed, ${c.canaryHits} canary hits`} |`);
process.exit(0);
