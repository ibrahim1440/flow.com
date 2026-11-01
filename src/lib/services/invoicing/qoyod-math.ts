// «وضع التجربة مع قيود» (owner's pilot, Nov–Dec 2026) — the pure half: what a Qoyod PDF must look like, the pilot rule
// for this system's own documents, and the message the customer receives with the PDF.
//
// The rule: while the pilot runs, ZATCA is off here and the customer's tax invoice is the one Qoyod issued. A document
// this system issued before `qoyodPilotUntil` is an INTERNAL COPY for the books — never a tax invoice: printed with a
// watermark and no QR, and never sent to the customer from here. What the customer gets is Qoyod's PDF, attached to
// the document by the accountant and sent by the rep.

export const QOYOD_PDF_MAX_BYTES = 5 * 1024 * 1024;
export const QOYOD_NUMBER_MAX = 60;

/** A PDF by its own signature ("%PDF-" in the first bytes), never by the name or the browser's claim. */
export function isPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

/** Qoyod's invoice number as typed: trimmed, inner spaces collapsed; null when empty, too long or multi-line. */
export function normQoyodNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[\r\n]/.test(raw)) return null;
  const v = raw.trim().replace(/\s+/g, " ");
  return v.length >= 1 && v.length <= QOYOD_NUMBER_MAX ? v : null;
}

/** The file name the customer sees: «Invoice-<Qoyod number>.pdf», ASCII only (every mail client and phone shows it). */
export function qoyodFileName(qoyodNumber: string): string {
  const safe = qoyodNumber.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `Invoice-${safe || "Qoyod"}.pdf`;
}

const day = (d: Date | string | null | undefined): string | null => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** True when this issued document is a pilot internal copy: issued (Riyadh day) before the pilot's end. */
export function isInternalCopy(doc: { status: string; issueDate: Date | string | null }, pilotUntil: Date | string | null): boolean {
  const until = day(pilotUntil), issued = day(doc.issueDate);
  if (!until) return false;
  if (doc.status !== "ISSUED") return false;
  return !!issued && issued < until;
}

/** True while the pilot runs on this Riyadh day. */
export function pilotActive(pilotUntil: Date | string | null, today: string): boolean {
  const until = day(pilotUntil);
  return !!until && today < until;
}

const money = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The WhatsApp caption and the e-mail body (plain text; the e-mail wrapper adds the company footer). */
export function qoyodMessage(i: { customerName: string; qoyodNumber: string; total: string; company: string; kind?: string }): { subject: string; body: string } {
  const what = i.kind === "CREDIT_NOTE" ? "إشعاركم الدائن" : i.kind === "DEBIT_NOTE" ? "إشعاركم المدين" : "فاتورتكم الضريبية";
  const whatTitle = i.kind === "CREDIT_NOTE" ? "إشعار دائن" : i.kind === "DEBIT_NOTE" ? "إشعار مدين" : "فاتورة ضريبية";
  const name = i.customerName.trim();
  const body = [
    name ? `مرحبًا ${name}،` : "مرحبًا،",
    `مرفق ${what} رقم ${i.qoyodNumber} بقيمة ${money(i.total)} ر.س شاملة الضريبة.`,
    `شاكرين لكم تعاملكم مع ${i.company}.`,
  ].join("\n");
  const subject = `${whatTitle} رقم ${i.qoyodNumber} — ${i.company}`.replace(/[\r\n]+/g, " ").slice(0, 200);
  return { subject, body };
}

/** One send of one version of the copy to one customer: «qoyod:<copy>:v<version>:n<send no>:customer:<id>». */
export function qoyodDedupeKey(copyId: string, version: number, sendNo: number, customerId: string, channel: "whatsapp" | "email"): string {
  const k = `qoyod:${copyId}:v${version}:n${sendNo}:customer:${customerId}`;
  return channel === "email" ? `email:${k}` : k;
}
