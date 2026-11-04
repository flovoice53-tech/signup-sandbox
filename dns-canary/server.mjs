// DNS canary for the containment benchmark. It is the authoritative name
// server for one delegated zone (DNS_ZONE, e.g. dns.flo-voice1.com), so a
// lookup of <token>.<zone> made from anywhere on the internet ends up here.
// Attack pages try to leak a token through DNS; if any such query arrives,
// the token's count goes up. The bench reads the counts over a loopback-only
// HTTP API: GET /hits/<token> → {"hits": n}.
//
// It only answers for its own zone, every reply is small (no amplification),
// and each source IP is rate-limited. Names outside the zone are REFUSED.
import dgram from "node:dgram";
import http from "node:http";

const ZONE = (process.env.DNS_ZONE ?? "").toLowerCase().replace(/\.$/, "");
const NS_HOST = (process.env.DNS_NS_HOST ?? "").toLowerCase().replace(/\.$/, "");
const BIND = process.env.DNS_BIND ?? "0.0.0.0";
const API_PORT = Number(process.env.DNS_API_PORT ?? 4053);
if (!ZONE || !NS_HOST) throw new Error("set DNS_ZONE and DNS_NS_HOST");

const hits = new Map();
const PER_IP_PER_SECOND = 50;
const recent = new Map();

function log(event) {
  process.stdout.write(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

function readName(buf, offset) {
  const labels = [];
  for (let jumps = 0; offset < buf.length && jumps < 20; ) {
    const len = buf[offset];
    if (len === 0) return { name: labels.join("."), end: offset + 1 };
    if ((len & 0xc0) === 0xc0) return null; // no compression in questions we accept
    labels.push(buf.toString("latin1", offset + 1, offset + 1 + len));
    offset += 1 + len;
    jumps++;
  }
  return null;
}

function encodeName(name) {
  const parts = name.split(".").filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function rr(name, type, ttl, rdata) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2); // IN
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function soa() {
  const nums = Buffer.alloc(20);
  [1, 3600, 600, 86400, 1].forEach((n, i) => nums.writeUInt32BE(n, i * 4)); // minimum 1s: no negative caching
  return rr(ZONE, 6, 1, Buffer.concat([encodeName(NS_HOST), encodeName(`hostmaster.${ZONE}`), nums]));
}

function reply(query, question, rcode, answers = [], authority = []) {
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2); // id
  const rd = query[2] & 0x01;
  head[2] = 0x84 | rd; // QR + AA
  head[3] = rcode;
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(answers.length, 6);
  head.writeUInt16BE(authority.length, 8);
  head.writeUInt16BE(0, 10);
  return Buffer.concat([head, question, ...answers, ...authority]);
}

const sock = dgram.createSocket("udp4");
sock.on("message", (msg, from) => {
  const now = Date.now();
  const r = recent.get(from.address);
  if (r && now - r.since < 1000) {
    if (++r.n > PER_IP_PER_SECOND) return;
  } else recent.set(from.address, { since: now, n: 1 });
  if (recent.size > 10_000) recent.clear();

  if (msg.length < 17 || msg.readUInt16BE(4) !== 1 || msg[2] & 0x80) return;
  const q = readName(msg, 12);
  if (!q || q.end + 4 > msg.length) return;
  const qtype = msg.readUInt16BE(q.end);
  const question = msg.subarray(12, q.end + 4);
  const name = q.name.toLowerCase(); // resolvers randomise case (0x20)

  if (name !== ZONE && !name.endsWith(`.${ZONE}`)) {
    sock.send(reply(msg, question, 5), from.port, from.address); // REFUSED
    return;
  }
  const label = name === ZONE ? "" : name.slice(0, -ZONE.length - 1).split(".").pop();
  if (label) {
    hits.set(label, (hits.get(label) ?? 0) + 1);
    if (hits.size > 5000) hits.clear();
    log({ type: "query", name, qtype, from: from.address });
  }
  let out;
  if (name === ZONE && qtype === 2) out = reply(msg, question, 0, [rr(ZONE, 2, 300, encodeName(NS_HOST))]);
  else if (name === ZONE && qtype === 6) out = reply(msg, question, 0, [soa()]);
  else if (name === ZONE) out = reply(msg, question, 0, [], [soa()]); // NODATA
  else out = reply(msg, question, 3, [], [soa()]); // NXDOMAIN
  sock.send(out, from.port, from.address);
});
sock.bind(53, BIND, () => log({ type: "ready", zone: ZONE, bind: BIND }));

http
  .createServer((req, res) => {
    const m = /^\/hits\/([a-z0-9]{1,63})$/.exec(req.url ?? "");
    if (req.method !== "GET" || !m) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hits: hits.get(m[1].toLowerCase()) ?? 0 }));
  })
  .listen(API_PORT, "127.0.0.1");
