// Disposable inboxes for the agent's test identity. These calls run in the
// orchestrator, outside the sandbox: the browser never sees the mailbox
// secret, only the address it types into the form.
//
// INBOX=receivemail (default) uses receivemail.dev. INBOX=local keeps mail
// in memory and is only for development without an SMTP server: the demo
// sites hand their emails straight to it.
export type Mail = { from: string; subject: string; body: string; receivedAt: string };
export type Mailbox = { address: string; secret: string };

const RECEIVEMAIL = process.env.RECEIVEMAIL_URL ?? "https://receivemail.dev";
export const INBOX_MODE = process.env.INBOX === "local" ? "local" : "receivemail";

const localMail = new Map<string, Mail[]>();

// Addresses this process created, with their expiry. The demo sites only
// email these, so they can't be used to send mail to anyone else.
const ourMailboxes = new Map<string, number>();
const MAILBOX_TTL_MS = 30 * 60_000;

export function isOurMailbox(address: string) {
  const expires = ourMailboxes.get(address.toLowerCase());
  return expires !== undefined && expires > Date.now();
}

setInterval(() => {
  for (const [address, expires] of ourMailboxes) {
    if (expires < Date.now()) {
      ourMailboxes.delete(address);
      localMail.delete(address);
    }
  }
}, 5 * 60_000).unref();

export function deliverLocal(to: string, mail: Omit<Mail, "receivedAt">) {
  const list = localMail.get(to.toLowerCase());
  if (list) list.push({ ...mail, receivedAt: new Date().toISOString() });
}

export async function createMailbox(): Promise<Mailbox> {
  const box = await newMailbox();
  ourMailboxes.set(box.address.toLowerCase(), Date.now() + MAILBOX_TTL_MS);
  return box;
}

async function newMailbox(): Promise<Mailbox> {
  if (INBOX_MODE === "local") {
    const address = `agent-${Math.random().toString(36).slice(2, 10)}@inbox.local`;
    localMail.set(address, []);
    return { address, secret: "" };
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.RECEIVEMAIL_API_KEY) headers.authorization = `Bearer ${process.env.RECEIVEMAIL_API_KEY}`;
  const res = await fetch(`${RECEIVEMAIL}/mailboxes`, { method: "POST", headers, body: JSON.stringify({ ttlMinutes: 30 }), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`receivemail: ${res.status} ${await res.text()}`);
  const { address, secret } = (await res.json()) as Mailbox;
  return { address, secret };
}

// Waits for the first message newer than `since`, up to `timeoutMs`.
export async function waitForMail(box: Mailbox, since: string, timeoutMs: number): Promise<Mail | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (INBOX_MODE === "local") {
      const mail = localMail.get(box.address)?.find((m) => m.receivedAt > since);
      if (mail) return mail;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const seconds = Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
    const res = await fetch(
      `${RECEIVEMAIL}/mailboxes/${encodeURIComponent(box.address)}/wait?timeout=${seconds}&since=${encodeURIComponent(since)}`,
      { headers: { authorization: `Bearer ${box.secret}` }, signal: AbortSignal.timeout((seconds + 10) * 1000) },
    );
    if (!res.ok) throw new Error(`receivemail: ${res.status}`);
    const data = (await res.json()) as {
      timed_out: boolean;
      message: { from_address: string; subject: string; body_text: string; received_at: string } | null;
    };
    if (data.message) {
      const m = data.message;
      return { from: m.from_address, subject: m.subject, body: m.body_text, receivedAt: m.received_at };
    }
  }
  return null;
}

// Pulls what a verification email usually carries: a short numeric code
// and/or a link. Footers are full of other numbers (years, addresses) and
// links (logo, unsubscribe), so prefer the ones that look like verification.
export function extractVerification(mail: Mail) {
  const text = `${mail.subject}\n${mail.body}`;
  const nearWord = text.match(/(?:code|pin|otp|verification|verify)\D{0,30}?\b(\d{4,8})\b/i)?.[1];
  const anyCode = [...text.matchAll(/\b(\d{4,8})\b/g)].map((m) => m[1]).find((n) => !/^(19|20)\d{2}$/.test(n));
  const links = mail.body.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const verifyLink = links.find((l) => /verif|confirm|activat|token|magic|signup|register/i.test(l));
  const link = verifyLink ?? links.find((l) => !/unsubscribe|privacy|terms|logo|\.(png|jpe?g|gif|svg)(\?|$)/i.test(l)) ?? null;
  return { code: nearWord ?? anyCode ?? null, link };
}
