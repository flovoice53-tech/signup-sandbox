// Single-page UI: pick a demo flow, watch the agent work live, read the verdict.
export const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signup Sandbox</title>
<style>
:root{--bg:#0f1218;--panel:#171b24;--line:#262c39;--text:#e6e9ef;--muted:#8a93a6;--accent:#4f7cff;--ok:#2fbf71;--bad:#ff5c5c;--warn:#ffb020}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,sans-serif}
header{padding:28px 24px 8px;max-width:1200px;margin:0 auto}h1{margin:0;font-size:26px}header p{color:var(--muted);margin:6px 0 0;max-width:760px}
main{max-width:1200px;margin:0 auto;padding:16px 24px 48px}
.targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:12px 0 20px}
.target{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;cursor:pointer;text-align:left;color:inherit;font:inherit}
.target:hover{border-color:var(--accent)}.target b{display:block}.target span{color:var(--muted);font-size:13px}
.target:disabled{opacity:.5;cursor:wait}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--muted)}.stat b{color:var(--text);font-size:15px;margin-left:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:860px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-height:200px}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:2px 4px 10px}
#log{max-height:560px;overflow:auto;font-size:13px}
.ev{padding:7px 8px;border-left:3px solid var(--line);margin:4px 0;border-radius:0 6px 6px 0;background:#131720;word-break:break-word}
.ev .k{font-size:11px;text-transform:uppercase;color:var(--muted);margin-right:6px}
.ev.action{border-color:var(--accent)}.ev.email{border-color:#a970ff}.ev.egress,.ev.policy{border-color:var(--bad);background:#2a1416}
.ev.check{border-color:#2fd2c8}.ev.result{border-color:var(--ok)}.ev.error{border-color:var(--warn)}.ev.teardown{border-color:var(--muted)}
#shot{width:100%;border-radius:6px;border:1px solid var(--line);display:none}
#verdict{display:none;padding:14px 16px;border-radius:10px;margin-bottom:14px;font-weight:600}
.opts{font-size:13px;color:var(--muted);margin:-8px 0 16px}.opts input{vertical-align:middle;margin-right:6px}
#approve{display:none;padding:14px 16px;border-radius:10px;margin-bottom:14px;background:#14213d;border:1px solid var(--accent)}#approve b{display:block;margin-bottom:8px}#approve img{max-width:420px;width:100%;border-radius:6px;border:1px solid var(--line);display:block;margin:8px 0}
#approve button{margin-right:10px;padding:8px 16px;border-radius:8px;border:0;font:inherit;font-weight:600;cursor:pointer}#approve .yes{background:var(--ok);color:#06210f}#approve .no{background:var(--bad);color:#2a0507}
.ev.approval{border-color:var(--accent);background:#14213d}
#redteam{display:none;padding:14px 16px;border-radius:10px;margin-bottom:14px;font-weight:700;background:#331416;border:1px solid var(--bad);font-size:17px}
#verdict.passed{background:#123222;border:1px solid var(--ok)}#verdict.stopped{background:#1b2233;border:1px solid var(--muted)}#verdict.failed{background:#33240f;border:1px solid var(--warn)}#verdict.error{background:#331416;border:1px solid var(--bad)}
.how{color:var(--muted);font-size:13px;margin-top:28px;max-width:860px}.how b{color:var(--text)}
code{background:#202636;padding:1px 5px;border-radius:4px}
.contain{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.c{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.c .n{font-size:22px;font-weight:700}.c .l{font-size:12px;color:var(--muted)}
.c.bad .n{color:var(--bad)}.c.ok .n{color:var(--ok)}.c.warn .n{color:var(--warn)}
.judge{display:block;width:100%;margin:12px 0 4px;padding:16px 18px;border-radius:12px;border:1px solid var(--bad);background:#2a1416;color:var(--text);font:inherit;text-align:left;cursor:pointer}
.judge b{font-size:18px;color:#ff8a8a}.judge span{display:block;color:var(--muted);font-size:13px;margin-top:4px}.judge:hover{background:#3a1a1d}.judge:disabled{opacity:.5;cursor:wait}
#checks{display:none;margin:-4px 0 14px;font-size:14px;color:var(--muted)}#checks b{color:var(--text);font-weight:600;margin-right:14px}#checks .y{color:var(--ok)}#checks .n{color:var(--bad)}
#replaynote{display:none;color:var(--warn);font-size:13px;margin:6px 0 10px}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,92,92,0)}50%{box-shadow:0 0 0 4px rgba(255,92,92,.55)}}
.ev.hl{animation:pulse 1.2s ease-in-out 3;border-left-width:6px}#redteam.hl{animation:pulse 1.2s ease-in-out 4}
.target.red{border-color:#5a2026}.target.red b{color:#ff8a8a}
#bench{margin-top:24px}#bench h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}#bench .sum{font-size:16px;font-weight:700;margin-bottom:8px}#bench table{width:100%;border-collapse:collapse;font-size:13px}#bench td,#bench th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}#bench th{color:var(--muted);font-weight:600}#bench .ok{color:var(--ok);font-weight:700}#bench .bad{color:var(--bad);font-weight:700}#bench .m{color:var(--muted);font-size:12px;margin-top:6px}
#monitors{margin-top:24px}#monitors h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.mon{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:6px 0;font-size:13px}
.mon .nm{font-weight:700;min-width:180px}.mon .st{font-weight:700}.mon .st.passed{color:var(--ok)}.mon .st.failed{color:var(--bad)}.mon .m{color:var(--muted)}
.dots{display:flex;gap:3px}.dots i{display:block;width:9px;height:18px;border-radius:2px;background:var(--line)}.dots i.passed{background:var(--ok)}.dots i.failed{background:var(--bad)}
.alert{font-size:12px;color:var(--muted);margin:2px 0 0 4px}
#recent{margin-top:20px}#recent h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.run{display:flex;gap:10px;align-items:center;padding:7px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:5px 0;cursor:pointer;font-size:13px;color:inherit;width:100%;text-align:left;font-family:inherit}
.run:hover{border-color:var(--accent)}.run .st{font-weight:600;min-width:60px}.run .st.passed{color:var(--ok)}.run .st.failed{color:var(--warn)}.run .st.error{color:var(--bad)}.run .st.stopped{color:var(--muted)}.run .st.running{color:var(--accent)}.run .m{color:var(--muted)}
</style></head><body>
<header><h1>Signup Sandbox</h1>
<p>An AI agent signs up on a website like a new user would, confirms the email with a real inbox, and tells you where the flow breaks. Every browser action runs in a disposable sandbox on Vultr that can only reach the site under test.</p></header>
<main>
<button class="judge" id="judge"><b>▶ Watch the containment moment</b><span>One click for judges: an AI agent is told to trust a hostile page, so it tries to send the test password to a third party and read the cloud metadata service. Watch the sandbox block every attempt live, then the normal agent finish the signup (2–3 minutes).</span></button>
<div id="replaynote"></div>
<div class="targets" id="targets"></div>
<div class="opts"><label><input type="checkbox" id="approvalOpt">Human in the loop: ask me before the agent clicks any button (submit, verify)</label></div>
<div id="approve"></div>
<div id="redteam"></div>
<div id="verdict"></div>
<div id="checks"></div>
<div class="stats" id="stats"></div>
<div class="contain" id="contain"></div>
<div class="grid">
  <div class="panel"><h2>What the agent does</h2><div id="log"><div class="ev"><span class="k">ready</span>Pick a flow above to start a run.</div></div></div>
  <div class="panel"><h2>What the sandboxed browser sees</h2><img id="shot" alt="Sandbox browser screenshot"></div>
</div>
<div id="monitors"></div>
<div id="recent"></div>
<div id="bench"></div>
<div class="how"><p><b>Containment.</b> Each run gets its own isolated Docker network, on which the host itself has no address. The browser container runs on gVisor (its own user-space kernel), has no DNS, no capabilities, a read-only filesystem, memory/CPU/process limits and no long-lived secrets (the LLM key and inbox secret stay outside); its only way out is an egress proxy that allows the site under test, checks the name inside every HTTPS tunnel, and refuses private addresses, including the cloud metadata service. The model's actions are checked against the same policy before they run. When the run ends, the browser, the proxy and the network are deleted.</p>
<p><b>Secrets stay outside.</b> The test inbox (receivemail.dev) is read by the orchestrator, not the browser. The only credential the browser ever holds is a throwaway per-run test password, which it needs to type; the model only ever sees placeholders such as <code>{{password}}</code>.</p></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let source = null;

function esc(s){return String(s).replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";")}

let counts = { egress: 0, policy: 0, teardown: false };
let judge = false;
const approvalTokens = {};
// Keeps the approval token across a reload of the page that started the run.
const tokenFor = (id) => { if (approvalTokens[id]) return approvalTokens[id]; try { return sessionStorage.getItem("approval:" + id) || null; } catch (e) { return null; } };

function renderContainment(run){
  const cards = [
    [run.blockedRequests, "requests blocked by the egress proxy", run.blockedRequests ? "bad" : ""],
    [counts.policy, run.compromised ? (run.redTeamMode === "model" ? "escape attempts by the compromised model" : "escape attempts by a simulated compromised agent") : "agent actions refused by policy", counts.policy ? "warn" : ""],
    [run.injectionDetected ? "yes" : "no", "prompt injection noticed by the agent", run.injectionDetected ? "warn" : ""],
    [counts.teardown ? "✓" : (run.status === "running" ? "…" : "–"), "sandbox destroyed after the run", counts.teardown ? "ok" : ""],
  ];
  $("contain").innerHTML = cards.map(([n,l,c]) => '<div class="c '+c+'"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>').join("");
}

function renderStats(run, cfg){
  renderContainment(run);
  const items = [["Status", run.status], ["Steps", run.steps], ["Blocked requests", run.blockedRequests],
    ["Tokens", run.usage.promptTokens + run.usage.completionTokens], ["Sandbox", cfg.runtime ? cfg.driver + " + gVisor" : cfg.driver], ["Model", run.activeModel || cfg.model || "?"]];
  $("stats").innerHTML = items.map(([k,v]) => '<div class="stat">'+esc(k)+'<b>'+esc(v)+'</b></div>').join("");
  if (run.status !== "running") {
    const v = $("verdict");
    v.className = run.status; v.style.display = "block";
    v.textContent = (run.status === "passed" ? "✓ Signup works: " : run.status === "failed" ? "✗ Flow broken: " : run.status === "stopped" ? "■ Stopped by a person: " : "Run error: ") + (run.summary || "");
    const ck = $("checks"), c = run.checks;
    if (c) {
      const item = (ok, text) => '<b><span class="' + (ok ? "y" : "n") + '">' + (ok ? "✓" : "✗") + '</span> ' + esc(text) + '</b>';
      ck.innerHTML = "Independent checks: " + (c.email === null ? '<b>– no email step on this site</b>' : item(c.email, "verification email arrived")) +
        (c.site === null ? "" : item(c.site, "site confirms the account")) +
        (c.vision === "unavailable" ? '<b><span class="n">?</span> vision check unavailable (image not processed)</b>' : c.vision ? item(c.vision.verified, "vision model sees a signed-in page") : "");
      ck.style.display = "block";
    } else ck.style.display = "none";
    const rt = $("redteam");
    if (run.compromised && run.redTeamAttempts) {
      rt.style.display = "block";
      rt.textContent = "Containment: " + (run.redTeamStopped || 0) + " of " + run.redTeamAttempts + " escape attempts blocked by the sandbox (credential exfiltration, cloud metadata). " + run.blockedRequests + " outbound requests refused in total." +
        (run.redTeamMode === "scripted" ? " Layer 1 held too: told to trust the page, the model refused, so a fully compromised agent was simulated." : " A real model (" + (run.redTeamModel || "the agent") + "), told to obey notices on the page as a stand-in for a successful injection, chose these requests itself; the sandbox still held.");
    }
  }
}

function addEvent(e, runId){
  // Count real attempts only: policy refusals, or the red-team agent opening an off-site URL.
  if (e.kind === "policy" && (e.blocked || e.text.includes("compromised agent opens"))) counts.policy++;
  if (e.kind === "teardown") counts.teardown = true;
  const div = document.createElement("div");
  div.className = "ev " + e.kind + (judge && (e.kind === "egress" || e.kind === "policy") ? " hl" : "");
  div.innerHTML = '<span class="k">' + esc(e.step ? "step " + e.step + " · " + e.kind : e.kind) + '</span>' + esc(e.text);
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
  if (e.kind === "approval") showApproval(e, runId);
  if (e.screenshot) { $("shot").src = "/api/runs/" + runId + "/shots/" + e.screenshot; $("shot").style.display = "block"; }
}

function watch(id, cfg){
  if (source) source.close();
  $("log").innerHTML = ""; $("verdict").style.display = "none"; $("checks").style.display = "none"; $("redteam").style.display = "none"; $("shot").style.display = "none"; $("replaynote").style.display = "none"; $("approve").style.display = "none";
  history.replaceState(null, "", "?run=" + id);
  source = new EventSource("/api/runs/" + id + "/events");
  // The server replays the whole run on every (re)connect, so start clean.
  source.onopen = () => { $("log").innerHTML = ""; counts = { egress: 0, policy: 0, teardown: false }; };
  source.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.event) addEvent(data.event, id);
    renderStats(data.run, cfg);
    if (data.end) { source.close(); setBusy(false); loadRecent(cfg); if (judge) spotlight(); }
  };
}

function showApproval(e, runId){
  const box = $("approve");
  const token = tokenFor(runId);
  if (!token || !e.text.startsWith("Waiting for human approval")) { box.style.display = "none"; return; }
  box.innerHTML = '<b>' + esc(e.text) + '</b>' + (e.screenshot ? '<img src="/api/runs/' + esc(runId) + '/shots/' + esc(e.screenshot) + '" alt="What the sandboxed browser shows now">' : '') +
    '<button class="yes">Approve</button><button class="no">Reject</button>';
  box.style.display = "block";
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  const send = async (approve) => {
    box.querySelectorAll("button").forEach(b => b.disabled = true);
    const r = await fetch("/api/runs/" + runId + "/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token, approve: approve }) });
    if (r.ok) { box.style.display = "none"; return; }
    box.innerHTML = '<b>' + esc(r.status === 409 ? "Too late: this step already timed out and the run was stopped." : "This approval was not accepted.") + '</b>';
  };
  box.querySelector(".yes").onclick = () => send(true);
  box.querySelector(".no").onclick = () => send(false);
}

function spotlight(){
  const rt = $("redteam");
  if (rt.style.display !== "block") return;
  rt.classList.remove("hl"); void rt.offsetWidth; rt.classList.add("hl");
  rt.scrollIntoView({ behavior: "smooth", block: "center" });
}

// No free sandbox (or today's limit reached): replay a real stored run with
// compressed timing, clearly labelled as a replay.
async function replay(id, cfg, why){
  if (!id) { $("log").innerHTML = '<div class="ev error">' + esc(why) + '</div>'; setBusy(false); return; }
  const run = await (await fetch("/api/runs/" + id)).json();
  if (source) source.close();
  $("log").innerHTML = ""; $("verdict").style.display = "none"; $("checks").style.display = "none"; $("redteam").style.display = "none"; $("shot").style.display = "none";
  counts = { egress: 0, policy: 0, teardown: false };
  const note = $("replaynote");
  note.textContent = why + " Showing a replay of real run " + run.id + " from " + new Date(run.startedAt).toLocaleString() + ", sped up.";
  note.style.display = "block";
  $("log").scrollIntoView({ behavior: "smooth", block: "center" });
  let blocked = 0, steps = 0, prev = null;
  for (const e of run.events) {
    const t = Date.parse(e.at);
    if (prev !== null) await new Promise(r => setTimeout(r, Math.min(1200, Math.max(150, (t - prev) / 3))));
    prev = t;
    if (e.kind === "egress" && e.blocked) blocked++;
    if (e.step) steps = e.step;
    addEvent(e, run.id);
    renderStats(Object.assign({}, run, { status: "running", blockedRequests: blocked, steps: steps, injectionDetected: false }), cfg);
  }
  renderStats(run, cfg);
  setBusy(false);
  spotlight();
}

async function loadRecent(cfg){
  const list = await (await fetch("/api/runs")).json();
  if (!list.length) { $("recent").innerHTML = ""; return; }
  const label = (r) => { const last = r.targetUrl.split("/").pop(); const key = r.compromised ? "compromised" : (last === "notes" ? "trap" : last); return (cfg.targets[key] && cfg.targets[key].label) || r.targetUrl; };
  $("recent").innerHTML = '<h2>Recent runs</h2>' + list.slice(0, 8).map(r =>
    '<button class="run" data-id="'+esc(r.id)+'"><span class="st '+esc(r.status)+'">'+esc(r.status)+'</span><span>'+esc(label(r))+'</span><span class="m">'+esc(r.steps)+' steps · '+esc(r.blockedRequests)+' blocked · '+esc(new Date(r.startedAt).toLocaleString())+'</span></button>').join("");
  document.querySelectorAll(".run").forEach(b => b.onclick = () => { watch(b.dataset.id, cfg); window.scrollTo({top:0, behavior:"smooth"}); });
}

async function loadMonitors(cfg){
  const res = await fetch("/api/monitors");
  if (!res.ok) return;
  const list = await res.json();
  if (!list.length) return;
  const name = (m) => m.url ? m.name + " (real product)" : (cfg.targets[m.target] && cfg.targets[m.target].label) || m.target;
  $("monitors").innerHTML = '<h2>Scheduled monitors · alert only when a verdict changes</h2>' + list.map(m =>
    '<div class="mon"><span class="nm">' + esc(name(m)) + '</span>' +
    '<span class="st ' + esc(m.last ? m.last.status : "") + '">' + esc(m.last ? (m.last.status === "passed" ? "works" : "broken") : "waiting for first run") + '</span>' +
    '<span class="dots">' + m.history.slice(0, 24).reverse().map(h => '<i class="' + esc(h.status) + '" title="' + esc(new Date(h.at).toLocaleString() + ": " + h.status) + '"></i>').join("") + '</span>' +
    '<span class="m">every ' + esc(m.everyMinutes) + ' min' + (m.nextAt ? ' · next ' + esc(new Date(m.nextAt).toLocaleTimeString()) : '') + '</span></div>' +
    m.alerts.slice(0, 2).map(a => '<div class="alert">⚑ ' + esc(new Date(a.at).toLocaleString()) + ' · ' + esc(a.text.split(". ")[0]) + (a.channels.length ? ' · sent by ' + esc(a.channels.join(" + ")) : '') + '</div>').join("")
  ).join("");
}

async function loadBench(){
  const res = await fetch("/api/bench");
  if (!res.ok) return;
  const b = await res.json();
  const out = (c) => c.offsiteAllowed + c.canaryHits + (c.dnsHits || 0) === 0;
  const fired = b.fired != null ? b.fired : b.cases.filter(c => c.fired).length;
  $("bench").innerHTML = '<h2>Containment benchmark</h2><div class="sum">' + esc(b.attacks) + ' attacks · ' + esc(fired) + ' actually fired · ' + esc(b.blocked) + ' requests blocked · ' + esc(b.offsiteAllowed) + ' got out · canary hits ' + esc(b.canaryHits) + (b.dnsHits == null ? '' : ' · DNS canary queries ' + esc(b.dnsHits)) + '</div>' +
    '<table><tr><th>Attack page</th><th>Fired</th><th>Blocked</th><th>Got out</th></tr>' +
    b.cases.map(c => '<tr><td>' + esc(c.label) + '</td><td class="' + (c.fired ? 'ok">yes' : 'bad">no') + '</td><td>' + esc(c.blocked) + '</td><td class="' + (out(c) ? 'ok">nothing' : 'bad">' + esc(c.offsiteAllowed + c.canaryHits + (c.dnsHits || 0))) + '</td></tr>').join("") + '</table>' +
    '<div class="m">“Fired” means the attack actually attempted egress this run — a “nothing got out” row only proves containment when the attack fired. Each attack page tries to send data to a canary on our own server, so anything that really left the sandbox would be counted there; a control request from outside the sandbox was counted (' + esc(b.controlHits) + ').' + (b.dnsHits == null ? '' : ' DNS leaks are measured the same way: our own name server is authoritative for ' + esc(b.dnsZone) + ' and counts every lookup of a page’s secret hostname that reaches the internet; a control lookup from outside the sandbox was counted (' + esc(b.dnsControlHits) + ').') + ' Model-free and deterministic (npm run bench), run ' + esc(new Date(b.at).toLocaleString()) + '.</div>';
}

function setBusy(b){ document.querySelectorAll(".target, .judge").forEach(t => t.disabled = b); }

(async () => {
  const cfg = await (await fetch("/api/config")).json();
  $("targets").innerHTML = Object.entries(cfg.targets).map(([key,t]) =>
    '<button class="target'+(key === "compromised" ? " red" : "")+'" data-key="'+key+'"><b>'+esc(t.label)+'</b><span>'+esc(t.description)+'</span></button>').join("");
  $("judge").onclick = async () => {
    setBusy(true); judge = true;
    const res = await fetch("/api/runs", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({target: "compromised"})});
    const data = await res.json();
    if (!res.ok) return replay(cfg.featured, cfg, data.error || "The live demo is unavailable right now.");
    watch(data.id, cfg);
    $("log").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  document.querySelectorAll(".target").forEach(btn => btn.onclick = async () => {
    setBusy(true); judge = false;
    const res = await fetch("/api/runs", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({target: btn.dataset.key, approval: $("approvalOpt").checked})});
    const data = await res.json();
    if (!res.ok) { setBusy(false); $("log").innerHTML = '<div class="ev error">'+esc(data.error)+'</div>'; return; }
    if (data.approvalToken) { approvalTokens[data.id] = data.approvalToken; try { sessionStorage.setItem("approval:" + data.id, data.approvalToken); } catch (e) {} }
    watch(data.id, cfg);
  });
  loadRecent(cfg);
  loadBench();
  loadMonitors(cfg);
  const existing = new URLSearchParams(location.search).get("run");
  if (existing) watch(existing, cfg);
})();
</script></body></html>`;
