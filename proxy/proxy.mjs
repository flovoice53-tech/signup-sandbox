// Egress proxy for one sandbox run. It is the browser container's only way
// out: the run's Docker network is --internal, and this container is the
// only one also attached to a network with internet access.
//
// A request goes through only if its host is on ALLOW_HOSTS (comma
// separated, exact match) and every address it resolves to is public, so a
// page can't reach the cloud metadata service, the host, or a LAN through
// DNS tricks. Each decision is printed as one JSON line on stdout, which the
// orchestrator streams into the run's event log.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";

const PORT = Number(process.env.PORT ?? 3128);
const ALLOW = new Set(
  (process.env.ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const ALLOWED_PORTS = new Set([80, 443]);
// Development only (SANDBOX_DRIVER=local): lets the allowlisted demo host
// resolve to 127.0.0.1. Never set in production.
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === "1";
const DEV_PORT = Number(process.env.DEV_PORT ?? 0);

function log(event) {
  process.stdout.write(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivate(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}

// Returns the address to connect to, or a reason the request is refused.
async function check(host, port) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!ALLOWED_PORTS.has(port) && port !== DEV_PORT) return { reason: `port ${port} not allowed` };
  if (!ALLOW.has(host)) return { reason: "host not on the allowlist" };
  let addresses;
  try {
    addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return { reason: "DNS lookup failed" };
  }
  if (addresses.length === 0 || (!ALLOW_PRIVATE && addresses.some(isPrivate))) return { reason: "resolves to a private address" };
  return { address: addresses[0] };
}

const server = http.createServer(async (req, res) => {
  // Plain http requests arrive with an absolute URL.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const port = Number(url.port || 80);
  const verdict = await check(url.hostname, port);
  if (!verdict.address) {
    log({ type: "blocked", host: url.hostname, port, method: req.method, path: url.pathname, reason: verdict.reason });
    res.writeHead(403, { "content-type": "text/plain" }).end("Blocked by sandbox egress policy\n");
    return;
  }
  log({ type: "allowed", host: url.hostname, port, method: req.method, path: url.pathname });
  const headers = { ...req.headers, host: url.host };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = http.request(
    { host: verdict.address, port, method: req.method, path: url.pathname + url.search, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end());
  req.pipe(upstream);
});

// https: the browser asks for a tunnel with CONNECT host:port.
server.on("connect", async (req, socket, head) => {
  const [host, portText] = (req.url ?? "").split(/:(?=\d+$)/);
  const port = Number(portText || 443);
  const verdict = await check(host ?? "", port);
  if (!verdict.address) {
    log({ type: "blocked", host, port, method: "CONNECT", reason: verdict.reason });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  log({ type: "allowed", host, port, method: "CONNECT" });
  const upstream = net.connect(port, verdict.address, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => log({ type: "ready", allow: [...ALLOW] }));
