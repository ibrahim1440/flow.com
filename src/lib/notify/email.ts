// E-mail for system notifications — a small adapter, DISABLED unless configured (feat/credit-hold).
//
// The application sent no e-mail before this (no nodemailer / Resend / SMTP / SendGrid client in
// package.json, no mail variable in .env.example, no password-reset mail). Nothing was signed up
// for. Two adapters, chosen by the environment:
//
//   * Resend (HTTPS API, no package):  RESEND_API_KEY + EMAIL_FROM («Hiqbah <alerts@your-domain>»,
//                                      a sender on a domain verified in Resend);
//   * an outbox directory (LOCAL ONLY): ALERT_EMAIL_OUTBOX_DIR — each message is written there as
//                                      JSON + HTML, for tests and the e-mail preview. Refused on
//                                      Vercel (VERCEL=1), so it can never swallow production mail.
//   * neither → "NOT_CONFIGURED": the in-app alert still appears; nothing is sent.
//
// Never logs a key, and never logs the recipients (a count only).
//
// Attachments (feature/email-demo): a message may carry files — `{ filename, contentBase64,
// contentType? }` — sent to Resend as `attachments: [{ filename, content }]` (content = base64) and,
// in the outbox, written next to the JSON (`<base>.att-<n>-<filename>`). Their decoded total is capped
// at EMAIL_ATTACHMENTS_MAX_BYTES (8 MB, under Resend's 40 MB request limit with room for the base64
// growth); a message over the cap is refused before any adapter is called (FAILED, nothing sent).
// `replyTo` (optional) is passed as Resend's `reply_to`.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type EmailAttachment = { filename: string; contentBase64: string; contentType?: string };
export type EmailMessage = {
  to: string[]; subject: string; html: string; text: string; attachments?: EmailAttachment[]; replyTo?: string;
  /** Extra mail headers (List-Unsubscribe…). Batch 25. Never a recipient header: cc / bcc are not supported at all. */
  headers?: Record<string, string>;
  /** Sent as Resend's Idempotency-Key request header (batch 25): a retried request is not delivered twice. */
  idempotencyKey?: string;
  /** Resend tags (fix round 2): the customer-automation channel tags its sends `hq=automation`, so its webhook can tell its own
   * delivery reports from those of the alert / HR / notification e-mails sent through the same account. */
  tags?: { name: string; value: string }[];
};
export type EmailResult = "SENT" | "FAILED" | "NOT_CONFIGURED" | "NO_RECIPIENTS";
/** What a provider answered (batch 25): its message id, when it gave one. */
export type AdapterReceipt = { providerMessageId: string | null; httpStatus: number | null } | void;
export type EmailAdapter = { name: string; send(m: EmailMessage): Promise<AdapterReceipt> };

/** A provider refusal, with the HTTP status (batch 25: the automation sender tells a transient error from a permanent one). */
export class EmailSendError extends Error {
  constructor(message: string, readonly httpStatus: number | null) { super(message); }
}

/** The detailed outcome of one send (batch 25; `sendEmail` keeps answering the plain EmailResult). */
export type EmailDelivery = {
  status: EmailResult;
  providerMessageId: string | null;
  httpStatus: number | null;
  /** True when trying again later may succeed (429, 5xx, timeout / network). */
  transient: boolean;
  error: string | null;
};

/** Header names a caller may set: never one that adds a recipient or changes the sender. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["to", "cc", "bcc", "from", "sender", "reply-to", "subject", "return-path"]);
export function safeHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) continue;
    out[k] = String(v).replace(/[\r\n]+/g, " ").slice(0, 900);
  }
  return out;
}

/** Where the Resend adapter posts. Only api.resend.com — or, for tests, a LOOPBACK mock (RESEND_API_URL=http://127.0.0.1:…). */
export function resendEndpoint(env: Record<string, string | undefined> = process.env): string {
  const o = env.RESEND_API_URL?.trim();
  if (!o) return "https://api.resend.com/emails";
  let u: URL;
  try { u = new URL(o); } catch { throw new Error("RESEND_API_URL is not a URL"); }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || env.VERCEL === "1") {
    throw new Error("RESEND_API_URL may only point at a loopback mock, and never on Vercel");
  }
  return `${u.origin}/emails`;
}

/** The decoded size of all attachments of one message, at most (8 MB). */
export const EMAIL_ATTACHMENTS_MAX_BYTES = 8 * 1024 * 1024;

/** The decoded byte length of a base64 string (without decoding it). */
export function base64Bytes(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  if (!s) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** Total decoded size of a message's attachments. */
export function attachmentsBytes(a: EmailAttachment[] | undefined): number {
  return (a ?? []).reduce((n, x) => n + base64Bytes(x.contentBase64), 0);
}

/** A file name safe for a mail header and a file system: no path, no control or quote characters. */
export function safeAttachmentName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "_").trim();
  return (base || "attachment").slice(0, 120);
}

/** The Resend request body (exported for the unit tests; the key is never part of it). */
export function resendBody(from: string, m: EmailMessage): Record<string, unknown> {
  const body: Record<string, unknown> = { from, to: m.to, subject: m.subject, html: m.html, text: m.text };
  if (m.replyTo) body.reply_to = m.replyTo;
  const headers = safeHeaders(m.headers);
  if (Object.keys(headers).length) body.headers = headers;
  const tags = (m.tags ?? []).filter((t) => /^[A-Za-z0-9_-]{1,256}$/.test(t.name) && /^[A-Za-z0-9_-]{1,256}$/.test(t.value)).slice(0, 10);
  if (tags.length) body.tags = tags;
  if (m.attachments?.length) {
    body.attachments = m.attachments.map((a) => ({ filename: safeAttachmentName(a.filename), content: a.contentBase64, ...(a.contentType ? { content_type: a.contentType } : {}) }));
  }
  return body;
}

/** The domain of the configured sender («Hiqbah <alerts@mail.example.com>» → «mail.example.com»), or null. Never the address. */
export function senderDomain(from: string | null | undefined): string | null {
  const t = (from ?? "").trim();
  if (!t) return null;
  const addr = (t.match(/<([^>]+)>/)?.[1] ?? t).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const d = addr.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/** Which provider the environment configures, for the settings screen (no secret, no address). */
export function emailProviderStatus(env: Record<string, string | undefined> = process.env): { provider: string | null; senderDomain: string | null } {
  const a = testAdapter !== undefined ? testAdapter : emailAdapterFromEnv(env);
  return { provider: a?.name ?? null, senderDomain: a?.name === "resend" ? senderDomain(env.EMAIL_FROM) : null };
}

export function emailAdapterFromEnv(env: Record<string, string | undefined> = process.env): EmailAdapter | null {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (key && from) {
    return {
      name: "resend",
      async send(m) {
        const endpoint = resendEndpoint(env);
        const r = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`, "Content-Type": "application/json",
            ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.replace(/[^A-Za-z0-9:_.-]/g, "").slice(0, 256) } : {}),
          },
          body: JSON.stringify(resendBody(from, m)),
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new EmailSendError(`resend ${r.status}`, r.status);
        const j = (await r.json().catch(() => null)) as { id?: unknown } | null;
        return { providerMessageId: typeof j?.id === "string" ? j.id : null, httpStatus: r.status };
      },
    };
  }
  const dir = env.ALERT_EMAIL_OUTBOX_DIR?.trim();
  if (dir && env.VERCEL !== "1") {
    return {
      name: "outbox",
      async send(m) {
        mkdirSync(dir, { recursive: true });
        const base = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        const files = (m.attachments ?? []).map((a, i) => {
          const file = `${path.basename(base)}.att-${i + 1}-${safeAttachmentName(a.filename)}`;
          writeFileSync(path.join(dir, file), Buffer.from(a.contentBase64, "base64"));
          return { filename: safeAttachmentName(a.filename), contentType: a.contentType ?? null, bytes: base64Bytes(a.contentBase64), file };
        });
        writeFileSync(`${base}.json`, JSON.stringify({ to: m.to, subject: m.subject, text: m.text, ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.headers ? { headers: safeHeaders(m.headers) } : {}), ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}), ...(files.length ? { attachments: files } : {}) }, null, 2));
        writeFileSync(`${base}.html`, m.html);
        // A stand-in provider id (batch 25), so the delivery webhook can be exercised locally.
        return { providerMessageId: `outbox-${path.basename(base)}`, httpStatus: 200 };
      },
    };
  }
  return null;
}

let testAdapter: EmailAdapter | null | undefined;
/** Unit tests inject a mock adapter (undefined restores the environment's). */
export function setEmailAdapterForTests(a: EmailAdapter | null | undefined) { testAdapter = a; }

/** Is an e-mail provider configured (the test adapter included)? */
export function emailConfigured(): boolean {
  return (testAdapter !== undefined ? testAdapter : emailAdapterFromEnv()) !== null;
}

export async function sendEmail(m: EmailMessage): Promise<EmailResult> {
  return (await deliverEmail(m)).status;
}

/** Send one message and say exactly what happened (batch 25). Never throws; never logs an address. */
export async function deliverEmail(m: EmailMessage): Promise<EmailDelivery> {
  const none = { providerMessageId: null, httpStatus: null, transient: false };
  const adapter = testAdapter !== undefined ? testAdapter : emailAdapterFromEnv();
  if (!adapter) return { ...none, status: "NOT_CONFIGURED", error: "No e-mail provider is configured." };
  const to = [...new Set(m.to.map((x) => x.trim()).filter(Boolean))];
  if (to.length === 0) return { ...none, status: "NO_RECIPIENTS", error: "No recipient." };
  if (attachmentsBytes(m.attachments) > EMAIL_ATTACHMENTS_MAX_BYTES) {
    console.error(`[alert-email] refused: attachments over ${EMAIL_ATTACHMENTS_MAX_BYTES} bytes (${m.attachments?.length ?? 0} file(s))`);
    return { ...none, status: "FAILED", error: "Attachments over the size limit." };
  }
  try {
    const receipt = await adapter.send({ ...m, to });
    return { status: "SENT", providerMessageId: receipt?.providerMessageId ?? null, httpStatus: receipt?.httpStatus ?? null, transient: false, error: null };
  } catch (e) {
    const httpStatus = e instanceof EmailSendError ? e.httpStatus : null;
    const transient = httpStatus === null || httpStatus === 429 || httpStatus >= 500;
    console.error(`[alert-email] ${adapter.name} failed for ${to.length} recipient(s): ${(e as Error)?.message ?? "error"}`);
    return { status: "FAILED", providerMessageId: null, httpStatus, transient, error: (e as Error)?.message?.slice(0, 200) ?? "Send failed." };
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The alert as an Arabic-first, RTL e-mail (inline styles — mail clients ignore stylesheets). */
export function alertEmailHtml(a: { titleAr: string; bodyAr: string; titleEn: string; bodyEn: string; severity: string; appUrl?: string | null; heading?: string }): string {
  const tone = a.severity === "success" ? "#1f7a4d" : a.severity === "danger" ? "#b42318" : "#a15c07";
  const para = (t: string) => t.split("\n").filter(Boolean).map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(a.titleAr)}</title></head>
<body style="margin:0;background:#f6f5f2;font-family:'IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;color:#1c1b19">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;border:1px solid #e7e4dd;overflow:hidden">
<div style="padding:14px 20px;border-bottom:1px solid #e7e4dd;font-weight:600">${esc(a.heading ?? "حِقبة · تنبيه النظام")}</div>
<div style="padding:20px">
<h1 style="margin:0 0 12px;font-size:18px;line-height:1.5;color:${tone}">${esc(a.titleAr)}</h1>
<div style="font-size:14px;line-height:1.8">${para(a.bodyAr)}</div>
${a.appUrl ? `<p style="margin:16px 0 0"><a href="${esc(a.appUrl)}" style="color:#1c1b19;font-weight:600">فتح النظام</a></p>` : ""}
<hr style="border:0;border-top:1px solid #e7e4dd;margin:20px 0">
<div dir="ltr" style="text-align:left;font-size:13px;line-height:1.7;color:#5f5b53"><b>${esc(a.titleEn)}</b>${para(a.bodyEn)}</div>
</div></div></body></html>`;
}
