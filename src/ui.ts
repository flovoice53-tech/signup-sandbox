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
.ev.result{border-color:var(--ok)}.ev.error{border-color:var(--warn)}.ev.teardown{border-color:var(--muted)}
#shot{width:100%;border-radius:6px;border:1px solid var(--line);display:none}
#verdict{display:none;padding:14px 16px;border-radius:10px;margin-bottom:14px;font-weight:600}
#redteam{display:none;padding:14px 16px;border-radius:10px;margin-bottom:14px;font-weight:700;background:#331416;border:1px solid var(--bad);font-size:17px}
#verdict.passed{background:#123222;border:1px solid var(--ok)}#verdict.failed{background:#33240f;border:1px solid var(--warn)}#verdict.error{background:#331416;border:1px solid var(--bad)}
.how{color:var(--muted);font-size:13px;margin-top:28px;max-width:860px}.how b{color:var(--text)}
code{background:#202636;padding:1px 5px;border-radius:4px}
.contain{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.c{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.c .n{font-size:22px;font-weight:700}.c .l{font-size:12px;color:var(--muted)}
.c.bad .n{color:var(--bad)}.c.ok .n{color:var(--ok)}.c.warn .n{color:var(--warn)}
.target.red{border-color:#5a2026}.target.red b{color:#ff8a8a}
#recent{margin-top:20px}#recent h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.run{display:flex;gap:10px;align-items:center;padding:7px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:5px 0;cursor:pointer;font-size:13px;color:inherit;width:100%;text-align:left;font-family:inherit}
.run:hover{border-color:var(--accent)}.run .st{font-weight:600;min-width:60px}.run .st.passed{color:var(--ok)}.run .st.failed{color:var(--warn)}.run .st.error{color:var(--bad)}.run .st.running{color:var(--accent)}.run .m{color:var(--muted)}
</style></head><body>
<header><h1>Signup Sandbox</h1>
<p>An AI agent signs up on a website like a new user would, confirms the email with a real inbox, and tells you where the flow breaks. Every browser action runs in a disposable sandbox on Vultr that can only reach the site under test.</p></header>
<main>
<div class="targets" id="targets"></div>
<div id="redteam"></div>
<div id="verdict"></div>
<div class="stats" id="stats"></div>
<div class="contain" id="contain"></div>
<div class="grid">
  <div class="panel"><h2>What the agent does</h2><div id="log"><div class="ev"><span class="k">ready</span>Pick a flow above to start a run.</div></div></div>
  <div class="panel"><h2>What the sandboxed browser sees</h2><img id="shot" alt="Sandbox browser screenshot"></div>
</div>
<div id="recent"></div>
<div class="how"><p><b>Containment.</b> Each run gets its own isolated Docker network. The browser container has no capabilities, a read-only filesystem, memory/CPU/process limits and no long-lived secrets (the LLM key and inbox secret stay outside); its only way out is an egress proxy that allows the site under test and refuses private addresses, including the cloud metadata service. The model's actions are checked against the same policy before they run. When the run ends, the browser, the proxy and the network are deleted.</p>
<p><b>Secrets stay outside.</b> The test inbox (receivemail.dev) is read by the orchestrator, not the browser. The only credential the browser ever holds is a throwaway per-run test password, which it needs to type; the model only ever sees placeholders such as <code>{{password}}</code>.</p></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let source = null;

function esc(s){return String(s).replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";")}

let counts = { egress: 0, policy: 0, teardown: false };

function renderContainment(run){
  const cards = [
    [run.blockedRequests, "requests blocked by the egress proxy", run.blockedRequests ? "bad" : ""],
    [counts.policy, run.compromised ? "simulated escape attempts (compromised agent)" : "agent actions refused by policy", counts.policy ? "warn" : ""],
    [run.injectionDetected ? "yes" : "no", "prompt injection noticed by the agent", run.injectionDetected ? "warn" : ""],
    [counts.teardown ? "✓" : (run.status === "running" ? "…" : "–"), "sandbox destroyed after the run", counts.teardown ? "ok" : ""],
  ];
  $("contain").innerHTML = cards.map(([n,l,c]) => '<div class="c '+c+'"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>').join("");
}

function renderStats(run, cfg){
  renderContainment(run);
  const items = [["Status", run.status], ["Steps", run.steps], ["Blocked requests", run.blockedRequests],
    ["Tokens", run.usage.promptTokens + run.usage.completionTokens], ["Sandbox", cfg.driver], ["Model", cfg.model || "?"]];
  $("stats").innerHTML = items.map(([k,v]) => '<div class="stat">'+esc(k)+'<b>'+esc(v)+'</b></div>').join("");
  if (run.status !== "running") {
    const v = $("verdict");
    v.className = run.status; v.style.display = "block";
    v.textContent = (run.status === "passed" ? "✓ Signup works: " : run.status === "failed" ? "✗ Flow broken: " : "Run error: ") + (run.summary || "");
    const rt = $("redteam");
    if (run.compromised && run.redTeamAttempts) {
      rt.style.display = "block";
      rt.textContent = "Containment: " + (run.redTeamStopped || 0) + " of " + run.redTeamAttempts + " escape attempts blocked by the sandbox (credential exfiltration, cloud metadata). " + run.blockedRequests + " outbound requests refused in total.";
    }
  }
}

function addEvent(e, runId){
  // Count real attempts only: policy refusals, or the red-team agent opening an off-site URL.
  if (e.kind === "policy" && (e.blocked || e.text.includes("compromised agent opens"))) counts.policy++;
  if (e.kind === "teardown") counts.teardown = true;
  const div = document.createElement("div");
  div.className = "ev " + e.kind;
  div.innerHTML = '<span class="k">' + esc(e.step ? "step " + e.step + " · " + e.kind : e.kind) + '</span>' + esc(e.text);
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
  if (e.screenshot) { $("shot").src = "/api/runs/" + runId + "/shots/" + e.screenshot; $("shot").style.display = "block"; }
}

function watch(id, cfg){
  if (source) source.close();
  $("log").innerHTML = ""; $("verdict").style.display = "none"; $("redteam").style.display = "none"; $("shot").style.display = "none";
  history.replaceState(null, "", "?run=" + id);
  source = new EventSource("/api/runs/" + id + "/events");
  // The server replays the whole run on every (re)connect, so start clean.
  source.onopen = () => { $("log").innerHTML = ""; counts = { egress: 0, policy: 0, teardown: false }; };
  source.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.event) addEvent(data.event, id);
    renderStats(data.run, cfg);
    if (data.end) { source.close(); setBusy(false); loadRecent(cfg); }
  };
}

async function loadRecent(cfg){
  const list = await (await fetch("/api/runs")).json();
  if (!list.length) { $("recent").innerHTML = ""; return; }
  const label = (r) => { const last = r.targetUrl.split("/").pop(); const key = r.compromised ? "compromised" : (last === "notes" ? "trap" : last); return (cfg.targets[key] && cfg.targets[key].label) || r.targetUrl; };
  $("recent").innerHTML = '<h2>Recent runs</h2>' + list.slice(0, 8).map(r =>
    '<button class="run" data-id="'+esc(r.id)+'"><span class="st '+esc(r.status)+'">'+esc(r.status)+'</span><span>'+esc(label(r))+'</span><span class="m">'+esc(r.steps)+' steps · '+esc(r.blockedRequests)+' blocked · '+esc(new Date(r.startedAt).toLocaleString())+'</span></button>').join("");
  document.querySelectorAll(".run").forEach(b => b.onclick = () => { watch(b.dataset.id, cfg); window.scrollTo({top:0, behavior:"smooth"}); });
}

function setBusy(b){ document.querySelectorAll(".target").forEach(t => t.disabled = b); }

(async () => {
  const cfg = await (await fetch("/api/config")).json();
  $("targets").innerHTML = Object.entries(cfg.targets).map(([key,t]) =>
    '<button class="target'+(key === "compromised" ? " red" : "")+'" data-key="'+key+'"><b>'+esc(t.label)+'</b><span>'+esc(t.description)+'</span></button>').join("");
  document.querySelectorAll(".target").forEach(btn => btn.onclick = async () => {
    setBusy(true);
    const res = await fetch("/api/runs", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({target: btn.dataset.key})});
    const data = await res.json();
    if (!res.ok) { setBusy(false); $("log").innerHTML = '<div class="ev error">'+esc(data.error)+'</div>'; return; }
    watch(data.id, cfg);
  });
  loadRecent(cfg);
  const existing = new URLSearchParams(location.search).get("run");
  if (existing) watch(existing, cfg);
})();
</script></body></html>`;
