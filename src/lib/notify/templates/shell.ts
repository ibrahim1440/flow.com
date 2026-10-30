// The house e-mail layout (feature/email-demo): Arabic first, right to left, inline styles only (mail
// clients drop stylesheets), table layout (Outlook), no image, no tracking pixel, no script, no external
// resource. Colours are the Direction 2.1 «Quiet Ledger» tokens (components/shell/direction-2.1.css):
// the warm neutral canvas, a white sheet with hairline rules, Deep Black text and the olive action
// colour as the one accent. Every value that reaches the HTML goes through esc().
import type { CompanyInfo } from "./types";

export const TOKENS = {
  canvas: "#f8f5ee",
  surface: "#ffffff",
  subtle: "#fbf9f4",
  rule: "#efeadf",
  ruleStrong: "#e3dccb",
  text: "#28241a",
  text2: "#4a473d",
  muted: "#6e6a61",
  olive: "#5c5c38",
  oliveTint: "#f0f0e9",
  warningTint: "#fbf2da",
  warning: "#946200",
  danger: "#b42318",
  dangerTint: "#fcebe8",
  font: "'IBM Plex Sans Arabic','IBM Plex Sans',Tahoma,'Segoe UI',Arial,sans-serif",
  num: "'IBM Plex Sans','IBM Plex Sans Arabic',Tahoma,Arial,sans-serif",
  mono: "'IBM Plex Mono',Consolas,'Courier New',monospace",
} as const;

export const DEMO_SUBJECT_PREFIX = "[تجريبي]";
export const DEMO_FOOTER_AR = "رسالة تجريبية من نظام حقبة — لا تتطلب أي إجراء";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** A left-to-right run inside Arabic text (a number, an IBAN, a document number). */
export const ltr = (s: string, mono = false) => `<bdi dir="ltr" style="unicode-bidi:isolate;font-family:${TOKENS.num}${mono ? ";letter-spacing:0.3px" : ""}">${esc(s)}</bdi>`;

export function subjectOf(subject: string, demo: boolean): string {
  return demo ? `${DEMO_SUBJECT_PREFIX} ${subject}` : subject;
}

export const para = (html: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.9;color:${TOKENS.text}">${html}</p>`;

/** A label / value list (the summary of a document). Values are HTML (already escaped). */
export function kvTable(rows: [string, string][]): string {
  return `<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 18px;background:${TOKENS.subtle};border:1px solid ${TOKENS.rule};border-radius:10px">
${rows.map(([k, v], i) => `<tr><td style="padding:10px 14px;${i ? `border-top:1px solid ${TOKENS.rule};` : ""}color:${TOKENS.muted};font-size:13px;white-space:nowrap;vertical-align:top;text-align:right">${esc(k)}</td><td style="padding:10px 14px;${i ? `border-top:1px solid ${TOKENS.rule};` : ""}font-size:14px;font-weight:600;color:${TOKENS.text};text-align:left">${v}</td></tr>`).join("\n")}
</table>`;
}

export type MailColumn = { label: string; numeric?: boolean };
/** A readable lines table: a header rule, hairlines between rows, figures aligned to the end edge. */
export function linesTable(columns: MailColumn[], rows: string[][], foot?: { label: string; value: string; grand?: boolean }[]): string {
  const th = (c: MailColumn) => `<th style="padding:8px 8px;border-bottom:1px solid ${TOKENS.ruleStrong};color:${TOKENS.muted};font-size:12px;font-weight:500;text-align:${c.numeric ? "left" : "right"};white-space:nowrap">${esc(c.label)}</th>`;
  const td = (c: MailColumn, v: string) => `<td style="padding:9px 8px;border-bottom:1px solid ${TOKENS.rule};font-size:13.5px;color:${TOKENS.text};text-align:${c.numeric ? "left" : "right"};${c.numeric ? `font-family:${TOKENS.num};white-space:nowrap;` : ""}vertical-align:top">${v}</td>`;
  const span = columns.length - 1;
  const footRows = (foot ?? []).map((f) => `<tr><td colspan="${span}" style="padding:7px 8px;text-align:left;font-size:13px;color:${f.grand ? TOKENS.text : TOKENS.text2};${f.grand ? `font-weight:600;border-top:1px solid ${TOKENS.ruleStrong};` : ""}">${esc(f.label)}</td><td style="padding:7px 8px;text-align:left;font-family:${TOKENS.num};white-space:nowrap;font-size:${f.grand ? "15px" : "13.5px"};${f.grand ? `font-weight:700;color:${TOKENS.olive};border-top:1px solid ${TOKENS.ruleStrong};` : `color:${TOKENS.text2};`}">${f.value}</td></tr>`).join("");
  return `<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 18px">
<thead><tr>${columns.map(th).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((v, i) => td(columns[i], v)).join("")}</tr>`).join("\n")}</tbody>
${footRows ? `<tfoot>${footRows}</tfoot>` : ""}
</table>`;
}

/** A note box: olive (information) or warning (attention). */
export function callout(html: string, tone: "info" | "warning" = "info"): string {
  const bg = tone === "warning" ? TOKENS.warningTint : TOKENS.oliveTint;
  const bar = tone === "warning" ? TOKENS.warning : TOKENS.olive;
  return `<div style="margin:4px 0 18px;padding:12px 14px;background:${bg};border-right:3px solid ${bar};border-radius:8px;font-size:14px;line-height:1.85;color:${TOKENS.text}">${html}</div>`;
}

export function companyLines(c: CompanyInfo): string[] {
  return [
    c.address,
    c.vatNumber ? `الرقم الضريبي ${c.vatNumber}` : null,
    c.crNumber ? `السجل التجاري ${c.crNumber}` : null,
    c.phone ? `هاتف ${c.phone}` : null,
  ].filter((x): x is string => !!x);
}

export function mailShell(o: {
  title: string;
  /** A short line over the title («عرض سعر» · the document number). */
  eyebrow?: string | null;
  company: CompanyInfo;
  demo: boolean;
  body: string;
  /** The sign-off under the body. */
  signature?: boolean;
}): string {
  const c = o.company;
  const brand = c.legal ? esc(c.nameAr) : "حِقبة";
  const sig = o.signature === false ? "" : `<p style="margin:18px 0 0;font-size:14px;line-height:1.8;color:${TOKENS.text2}">مع خالص التحية،<br><b style="color:${TOKENS.text}">${esc(c.nameAr)}</b>${c.phone ? `<br>${ltr(c.phone)}` : ""}</p>`;
  const details = [
    c.address ? esc(c.address) : null,
    c.vatNumber ? `الرقم الضريبي ${ltr(c.vatNumber)}` : null,
    c.crNumber ? `السجل التجاري ${ltr(c.crNumber)}` : null,
    c.phone ? `هاتف ${ltr(c.phone)}` : null,
  ].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${TOKENS.canvas};font-family:${TOKENS.font};color:${TOKENS.text};-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${TOKENS.canvas}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" dir="rtl" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${TOKENS.surface};border:1px solid ${TOKENS.rule};border-radius:12px;border-collapse:separate;overflow:hidden">
<tr><td style="height:4px;background:${TOKENS.olive};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:16px 24px;border-bottom:1px solid ${TOKENS.rule};text-align:right">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:16px;font-weight:700;color:${TOKENS.text};text-align:right">${brand}</td>
${o.demo ? `<td style="text-align:left"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${TOKENS.warningTint};color:${TOKENS.warning};font-size:12px;font-weight:600">رسالة تجريبية</span></td>` : ""}
</tr></table></td></tr>
<tr><td style="padding:24px 24px 8px;text-align:right">
${o.eyebrow ? `<div style="font-size:12.5px;color:${TOKENS.muted};margin:0 0 4px">${o.eyebrow}</div>` : ""}
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.5;font-weight:700;color:${TOKENS.text}">${esc(o.title)}</h1>
${o.body}
${sig}
</td></tr>
<tr><td style="padding:16px 24px 20px;border-top:1px solid ${TOKENS.rule};background:${TOKENS.subtle};text-align:right">
${o.demo ? `<p style="margin:0 0 6px;font-size:12.5px;font-weight:600;color:${TOKENS.warning}">${esc(DEMO_FOOTER_AR)}</p>` : ""}
<p style="margin:0;font-size:12px;line-height:1.7;color:${TOKENS.muted}">${esc(c.nameAr)}${details ? ` · ${details}` : ""}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** The plain-text part: the same content, line by line, with the demo footer. */
export function textOf(lines: (string | null | false | undefined)[], company: CompanyInfo, demo: boolean): string {
  return [...lines.filter((l): l is string => typeof l === "string"), "", "—", company.nameAr, ...companyLines(company), ...(demo ? ["", DEMO_FOOTER_AR] : [])].join("\n");
}
