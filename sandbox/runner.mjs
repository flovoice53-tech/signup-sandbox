// Runs inside the browser container. It holds no keys and makes no
// decisions: it drives one Chromium page and answers commands from the
// orchestrator, one JSON object per line on stdin, one reply per line on
// stdout. All traffic goes through the run's egress proxy (PROXY_URL).
import readline from "node:readline";
import { chromium } from "playwright";

const browser = await chromium.launch({
  proxy: process.env.PROXY_URL ? { server: process.env.PROXY_URL } : undefined,
  // <-loopback> stops Chromium from silently bypassing the proxy for
  // localhost, so even loopback requests hit the egress policy.
  // WebRTC is told to use only proxied connections, so no UDP leaves the
  // page outside the egress policy.
  args: [
    "--disable-dev-shm-usage",
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
});
const context = await browser.newContext({
  acceptDownloads: false,
  viewport: { width: 1280, height: 860 },
  serviceWorkers: "block",
});
const page = await context.newPage();
// A page can open popups; keep everything in the one tab the agent sees.
context.on("page", (p) => p !== page && p.close().catch(() => {}));

const ACTION_TIMEOUT = 8000;

// Tags every visible control with data-sbx-ref and describes it, so the
// agent can say "fill e3" instead of guessing selectors.
async function observe() {
  await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT }).catch(() => {});
  const snapshot = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const labelOf = (el) => {
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const text =
        el.getAttribute("aria-label") ||
        (byFor && byFor.innerText) ||
        (el.closest("label") && el.closest("label").innerText) ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.innerText ||
        el.getAttribute("value") ||
        "";
      return text.replace(/\s+/g, " ").trim().slice(0, 80);
    };
    const nodes = document.querySelectorAll(
      "input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=checkbox]",
    );
    const elements = [];
    let n = 0;
    for (const el of nodes) {
      if (elements.length >= 80) break;
      if (!visible(el)) continue;
      const ref = `e${++n}`;
      el.setAttribute("data-sbx-ref", ref);
      const tag = el.tagName.toLowerCase();
      const item = { ref, tag, label: labelOf(el) };
      if (tag === "input") item.type = el.type;
      if (tag === "select") item.options = [...el.options].map((o) => o.value).slice(0, 20);
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) item.checked = el.checked;
      else if (tag === "input" || tag === "textarea") item.filled = el.value.length > 0;
      elements.push(item);
    }
    return { title: document.title, text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 3000), elements };
  });
  const screenshot = (await page.screenshot({ type: "jpeg", quality: 60 })).toString("base64");
  return { url: page.url(), ...snapshot, screenshot };
}

const target = (ref) => page.locator(`[data-sbx-ref="${ref}"]`).first();

const commands = {
  async goto({ url }) {
    // A blocked navigation can still be settling; one retry gets past
    // "interrupted by another navigation".
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
        return { status: res?.status() ?? null };
      } catch (err) {
        if (attempt > 0 || !/interrupted by another navigation/.test(String(err))) throw err;
        await page.waitForTimeout(1000);
      }
    }
  },
  async fill({ ref, value }) {
    await target(ref).fill(String(value), { timeout: ACTION_TIMEOUT });
    return {};
  },
  async click({ ref }) {
    await target(ref).click({ timeout: ACTION_TIMEOUT });
    await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(500);
    return {};
  },
  async select({ ref, value }) {
    await target(ref).selectOption(String(value), { timeout: ACTION_TIMEOUT });
    return {};
  },
  async check({ ref }) {
    await target(ref).check({ timeout: ACTION_TIMEOUT });
    return {};
  },
  async wait({ ms }) {
    await page.waitForTimeout(Math.min(Number(ms) || 0, 10000));
    return {};
  },
  observe,
};

const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
reply({ ready: true });

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  const run = commands[msg.cmd];
  if (!run) {
    reply({ id: msg.id, ok: false, error: `unknown command ${msg.cmd}` });
    continue;
  }
  try {
    // A hostile page can hang the tab (e.g. an endless loop); answer with an
    // error instead of going silent.
    let timer;
    const deadline = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${msg.cmd} timed out`)), 20000)));
    const result = await Promise.race([run(msg), deadline]).finally(() => clearTimeout(timer));
    reply({ id: msg.id, ok: true, result });
  } catch (err) {
    reply({ id: msg.id, ok: false, error: String(err?.message ?? err).split("\n")[0].slice(0, 300) });
  }
}

await browser.close();
