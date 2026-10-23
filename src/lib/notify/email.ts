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

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type EmailMessage = { to: string[]; subject: string; html: string; text: string };
export type EmailResult = "SENT" | "FAILED" | "NOT_CONFIGURED" | "NO_RECIPIENTS";
export type EmailAdapter = { name: string; send(m: EmailMessage): Promise<void> };

export function emailAdapterFromEnv(env: Record<string, string | undefined> = process.env): EmailAdapter | null {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (key && from) {
    return {
      name: "resend",
      async send(m) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: m.to, subject: m.subject, html: m.html, text: m.text }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new Error(`resend ${r.status}`);
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
        writeFileSync(`${base}.json`, JSON.stringify({ to: m.to, subject: m.subject, text: m.text }, null, 2));
        writeFileSync(`${base}.html`, m.html);
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
  const adapter = testAdapter !== undefined ? testAdapter : emailAdapterFromEnv();
  if (!adapter) return "NOT_CONFIGURED";
  const to = [...new Set(m.to.map((x) => x.trim()).filter(Boolean))];
  if (to.length === 0) return "NO_RECIPIENTS";
  try {
    await adapter.send({ ...m, to });
    return "SENT";
  } catch (e) {
    console.error(`[alert-email] ${adapter.name} failed for ${to.length} recipient(s): ${(e as Error)?.message ?? "error"}`);
    return "FAILED";
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
