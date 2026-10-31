import "server-only";

/**
 * «تصدير PDF» of one customer's archived messages (batch 25b): Arabic, right to left, Riyadh time — the same rows the
 * archive screen and its CSV show to this viewer (the route applies the same scope). For a lawyer: every message with its
 * date, channel, recipient, subject and text, status, and the document reference / PDF fingerprint when one was attached.
 */
import { renderSheetPdf, type SheetCell } from "@/lib/notify/templates/pdf/sheet";

const STATUS_AR: Record<string, string> = {
  QUEUED: "ينتظر الإرسال", SENDING: "ينرسل", SENT: "انرسل", DELIVERED: "وصل", BOUNCED: "ارتدّ", COMPLAINED: "بلّغ عنه كسبام",
  FAILED: "فشل", SKIPPED: "ما انرسل", CANCELLED: "أُلغي",
};

/** dd/mm/yyyy HH:mm in Riyadh (24-hour, Latin digits). */
export function riyadh(d: Date | null | undefined): string {
  if (!d) return "—";
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
}

export type ArchivePdfRow = {
  channel: string; messageCreatedAt: Date; sentAt: Date | null; recipientName: string | null; address: string | null;
  subject: string | null; body: string; status: string; docRefId: string | null; docSha256: string | null; ruleName: string | null;
};

export function archivePdf(input: { customerName: string; customerId: string; rows: ArchivePdfRow[]; truncated: boolean; exportedBy: string; now: Date; company: string | null }): Buffer {
  const cell = (main: string, sub?: string | null): SheetCell => ({ main, sub: sub ?? null });
  const rows = input.rows.map((r) => [
    cell(riyadh(r.messageCreatedAt), r.sentAt ? `أُرسلت ${riyadh(r.sentAt)}` : null),
    cell(r.channel === "email" ? "إيميل" : "واتساب", r.ruleName),
    cell(r.recipientName ?? "—", r.address),
    cell(`${r.subject ? `${r.subject} — ` : ""}${r.body.length > 600 ? `${r.body.slice(0, 600)}…` : r.body}`,
      r.docRefId || r.docSha256 ? `المستند ${r.docRefId ?? "—"} · sha256 ${r.docSha256 ?? "—"}` : null),
    cell(STATUS_AR[r.status] ?? r.status),
  ]);
  return renderSheetPdf({
    info: { title: `أرشيف رسائل ${input.customerName}`, subject: "Message archive", createdAt: input.now },
    seller: input.company ? { name: input.company, lines: [] } : null,
    title: { main: "أرشيف رسائل العميل", lines: ["Message archive"] },
    banner: input.truncated ? { tone: "warning", title: "أول 2,000 رسالة فقط", text: "ضيّق البحث بالتاريخ لتصدير الباقي." } : null,
    metaStart: [
      { label: "العميل", value: input.customerName },
      { label: "رقم العميل", value: input.customerId, mono: true },
      { label: "عدد الرسائل", value: String(input.rows.length) },
    ],
    metaEnd: [
      { label: "وقت التصدير", value: `${riyadh(input.now)} (الرياض)` },
      { label: "صدّرها", value: input.exportedBy },
    ],
    columns: [
      { key: "date", label: "التاريخ (الرياض)", numeric: false, width: 1.2 },
      { key: "channel", label: "القناة", numeric: false, width: 0.8 },
      { key: "to", label: "المستلم", numeric: false, width: 1.3 },
      { key: "description", label: "الموضوع والنص", numeric: false },
      { key: "status", label: "الحالة", numeric: false, width: 0.8 },
    ],
    rows,
    footer: { legal: "نسخة من الأرشيف للمطالبات القانونية. الأوقات بتوقيت الرياض. لا تُعدّل رسائل الأرشيف ولا تُحذف إلا بالمسار المضبوط.", status: null, docNumber: input.customerId },
  });
}
