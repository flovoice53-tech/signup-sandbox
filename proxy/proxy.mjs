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

// Everything that isn't ordinary public unicast: loopback, private, link-local
// (incl. cloud metadata 169.254.169.254), CGNAT, multicast, NAT64/6to4
// wrappers that can point back at private IPv4, and so on.
const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]) blocked.addSubnet(prefix, bits, "ipv4");
for (const [prefix, bits] of [
  // Node's BlockList also matches IPv4 addresses against IPv6 ranges that
  // embed IPv4 (::/96, ::ffff:0:0/96), so those are handled in isPrivate.
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) blocked.addSubnet(prefix, bits, "ipv6");

function isPrivate(ip) {
  const embedded = ip.toLowerCase().match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return blocked.check(embedded[1], "ipv4");
  return blocked.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
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
  if (url.protocol !== "http:") {
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

// The name the client really asks for inside the tunnel: the SNI of a TLS
// ClientHello, or the Host header of a plain HTTP request (ws:// over a
// proxy). Returns undefined while more bytes are needed, null if there is none.
function innerHost(buf) {
  if (buf.length === 0) return undefined;
  if (buf[0] === 0x16) {
    if (buf.length < 5) return undefined;
    const end = 5 + buf.readUInt16BE(3);
    if (buf.length < end) return undefined;
    try {
      let p = 5;
      if (buf[p] !== 0x01) return null; // not a ClientHello
      p += 4 + 2 + 32; // handshake header, version, random
      p += 1 + buf[p]; // session id
      p += 2 + buf.readUInt16BE(p); // cipher suites
      p += 1 + buf[p]; // compression methods
      const extEnd = Math.min(end, p + 2 + buf.readUInt16BE(p));
      p += 2;
      while (p + 4 <= extEnd) {
        const type = buf.readUInt16BE(p);
        const len = buf.readUInt16BE(p + 2);
        if (type === 0 && buf[p + 6] === 0) return buf.toString("latin1", p + 9, p + 9 + buf.readUInt16BE(p + 7)).toLowerCase();
        p += 4 + len;
      }
    } catch {
      // malformed: no name
    }
    return null;
  }
  const text = buf.toString("latin1");
  const headEnd = text.indexOf("\r\n\r\n");
  if (headEnd === -1) return buf.length > 16384 || !/^[A-Z]+ /.test(text.slice(0, 8)) && buf.length >= 8 ? null : undefined;
  const m = /\r\nhost:[ \t]*([^\r\n]+)/i.exec(text.slice(0, headEnd));
  return m ? m[1].trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "") : null;
}

// https: the browser asks for a tunnel with CONNECT host:port. The CONNECT
// line only names the host; the bytes in the tunnel name it again (TLS SNI or
// HTTP Host), and a client can make the two differ to reach another site that
// shares the allowed host's IP or CDN ("domain fronting"). So the tunnel only
// opens once the inner name matches the allowed host.
server.on("connect", async (req, socket, head) => {
  const [host, portText] = (req.url ?? "").split(/:(?=\d+$)/);
  const port = Number(portText || 443);
  const verdict = await check(host ?? "", port);
  if (!verdict.address) {
    log({ type: "blocked", host, port, method: "CONNECT", reason: verdict.reason });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  socket.on("error", () => {});
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let buf = head;
  const timer = setTimeout(() => decide(null), 10_000);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const name = innerHost(buf);
    if (name !== undefined) decide(name);
  };
  let decided = false;
  function decide(name) {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    socket.off("data", onData);
    socket.pause();
    if (name !== host.toLowerCase()) {
      log({ type: "blocked", host, port, method: "CONNECT", inner: name ?? "(none)", reason: `name inside the tunnel (${name ?? "none"}) does not match ${host}` });
      socket.destroy();
      return;
    }
    log({ type: "allowed", host, port, method: "CONNECT" });
    const upstream = net.connect(port, verdict.address, () => {
      upstream.write(buf);
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.resume();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }
  const first = innerHost(buf);
  if (first !== undefined) decide(first);
  else socket.on("data", onData);
});

server.listen(PORT, () => log({ type: "ready", allow: [...ALLOW] }));
