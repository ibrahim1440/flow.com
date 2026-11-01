// «وضع التجربة مع قيود» (owner's pilot) — Qoyod's tax-invoice PDF on an issued document of this system:
//   upload   the accountant attaches the PDF and Qoyod's number (sales › invoices_issue, or accounting › ar); a
//            replacement bumps the version. The rep(s) of the document are told («فاتورة قيود جاهزة للإرسال»).
//   send     the rep presses «إرسال»: one WhatsApp file and one e-mail attachment to the customer, queued through the
//            automation queues — so the send mode (OFF / TEST / LIVE), the customer's opt-outs, the e-mail suppression
//            list, the delivery log and the 180-day archive all apply exactly as to every other message.
//   attach   the senders read the PDF again at send time (qoyod-attachment.ts): still this document's, still issued.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/hr/core";
import { notify } from "@/lib/notifications/notify";
import { currentEmailMode, suppressionLookup } from "@/lib/automation/email-dispatch";
import { planEmailDelivery } from "@/lib/automation/email-mode";
import { effectiveMode, planDelivery } from "@/lib/automation/send-mode";
import { readSettings } from "@/lib/automation/settings";
import { sellerSnapshot } from "./settings";
import { QOYOD_PDF_MAX_BYTES, isPdf, normQoyodNumber, qoyodDedupeKey, qoyodFileName, qoyodMessage } from "./qoyod-math";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
type AppError = { _appCode: number; message: string; errorEn: string; code: string };
const refuse = (status: number, code: string, message: string, errorEn: string): AppError => ({ _appCode: status, code, message, errorEn });

export const QOYOD_EVENT = "sales.invoice_status_changed";
const RULE_NAME = "فاتورة قيود";

/** The pilot's end (SystemConfig.qoyodPilotUntil), or null when no pilot is set. */
export async function qoyodPilotUntil(db: Db = prisma): Promise<Date | null> {
  const row = await db.systemConfig.findUnique({ where: { id: "singleton" }, select: { qoyodPilotUntil: true } });
  return row?.qoyodPilotUntil ?? null;
}

/** The copy as the screens show it (never the bytes) with the last messages sent of it. */
export async function qoyodCopyView(db: Db, invoiceId: string) {
  const c = await db.salesInvoiceQoyod.findUnique({
    where: { invoiceId },
    select: { id: true, qoyodNumber: true, filename: true, byteSize: true, checksum: true, version: true, uploadedAt: true, sendCount: true, lastSentAt: true, uploadedBy: { select: { name: true } }, lastSentBy: { select: { name: true } } },
  });
  if (!c) return null;
  const [wa, em] = await Promise.all([
    db.whatsAppMessage.findMany({ where: { attachmentKind: "qoyod_pdf", attachmentRefId: c.id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, statusNote: true, phone: true, intendedPhone: true, createdAt: true, sentAt: true } }),
    db.emailMessage.findMany({ where: { attachmentKind: "qoyod_pdf", attachmentRefId: c.id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, status: true, statusNote: true, toEmail: true, intendedEmail: true, createdAt: true, sentAt: true, deliveredAt: true } }),
  ]);
  return {
    id: c.id, qoyodNumber: c.qoyodNumber, filename: c.filename, byteSize: c.byteSize, checksum: c.checksum, version: c.version,
    uploadedAt: c.uploadedAt, uploadedBy: c.uploadedBy.name, sendCount: c.sendCount, lastSentAt: c.lastSentAt, lastSentBy: c.lastSentBy?.name ?? null,
    messages: [
      ...wa.map((m) => ({ id: m.id, channel: "whatsapp" as const, status: String(m.status), note: m.statusNote, address: m.phone, intended: m.intendedPhone, createdAt: m.createdAt, sentAt: m.sentAt, deliveredAt: null as Date | null })),
      ...em.map((m) => ({ id: m.id, channel: "email" as const, status: String(m.status), note: m.statusNote, address: m.toEmail, intended: m.intendedEmail, createdAt: m.createdAt, sentAt: m.sentAt, deliveredAt: m.deliveredAt })),
    ].sort((a, b) => +b.createdAt - +a.createdAt),
  };
}

type Head = { id: string; kind: string; status: string; number: string | null; customerId: string; orderId: string | null; requestedById: string | null; grandTotal: { toString(): string }; buyer: unknown };
const HEAD = { id: true, kind: true, status: true, number: true, customerId: true, orderId: true, requestedById: true, grandTotal: true, buyer: true } as const;

/** The people a Qoyod copy concerns: the requester, the order's owner, the customer's account owner. */
async function repsOf(tx: Tx, doc: Head) {
  const [order, customer] = await Promise.all([
    doc.orderId ? tx.order.findUnique({ where: { id: doc.orderId }, select: { ownerId: true } }) : Promise.resolve(null),
    tx.customer.findUnique({ where: { id: doc.customerId }, select: { accountOwnerId: true } }),
  ]);
  return { requester: doc.requestedById, orderOwner: order?.ownerId ?? null, customerOwner: customer?.accountOwnerId ?? null };
}

/** Attach (or replace) Qoyod's PDF on an ISSUED document. */
export async function uploadQoyodCopy(tx: Tx, input: { invoiceId: string; qoyodNumber: unknown; fileName: string; bytes: Buffer; actorId: string }) {
  const doc = await tx.salesInvoice.findUnique({ where: { id: input.invoiceId }, select: HEAD });
  if (!doc) throw refuse(404, "NOT_FOUND", "غير موجود.", "Not found.");
  if (doc.status !== "ISSUED") throw refuse(409, "NOT_ISSUED", "تُرفق فاتورة قيود على مستند صادر فقط — أصدر الفاتورة هنا أولًا.", "Attach Qoyod's invoice to an issued document only.");
  const number = normQoyodNumber(input.qoyodNumber);
  if (!number) throw refuse(400, "QOYOD_NUMBER", "اكتب رقم الفاتورة في قيود (سطر واحد، 60 حرفًا كحد أقصى).", "Give Qoyod's invoice number (one line, at most 60 characters).");
  if (input.bytes.length === 0) throw refuse(400, "EMPTY_FILE", "الملف فارغ.", "The file is empty.");
  if (input.bytes.length > QOYOD_PDF_MAX_BYTES) throw refuse(413, "TOO_LARGE", "حجم الملف أكبر من 5 ميغابايت.", "The file is larger than 5 MB.");
  if (!isPdf(input.bytes)) throw refuse(415, "NOT_PDF", "الملف ليس PDF. صدّر الفاتورة من قيود بصيغة PDF وارفعها.", "The file is not a PDF.");
  const checksum = createHash("sha256").update(input.bytes).digest("hex");
  const filename = qoyodFileName(number);
  // One copy per document, serialised per document so two uploads never race the version.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`qoyod:copy:${doc.id}`}, 0))`;
  const prev = await tx.salesInvoiceQoyod.findUnique({ where: { invoiceId: doc.id }, select: { id: true, qoyodNumber: true, checksum: true, version: true } });
  if (prev && prev.checksum === checksum && prev.qoyodNumber === number) return { id: prev.id, version: prev.version, replayed: true };
  const content = new Uint8Array(input.bytes);
  const row = prev
    ? await tx.salesInvoiceQoyod.update({ where: { id: prev.id }, data: { qoyodNumber: number, filename, byteSize: input.bytes.length, checksum, content, version: prev.version + 1, uploadedById: input.actorId, uploadedAt: new Date() }, select: { id: true, version: true } })
    : await tx.salesInvoiceQoyod.create({ data: { invoiceId: doc.id, qoyodNumber: number, filename, mimeType: "application/pdf", byteSize: input.bytes.length, checksum, content, uploadedById: input.actorId }, select: { id: true, version: true } });
  await audit(tx, {
    action: prev ? "QOYOD_INVOICE_REPLACED" : "QOYOD_INVOICE_ATTACHED", entityType: "SalesInvoice", entityId: doc.id, actorId: input.actorId,
    before: prev ? { qoyodNumber: prev.qoyodNumber, checksum: prev.checksum, version: prev.version } : undefined,
    after: { qoyodNumber: number, checksum, version: row.version, byteSize: input.bytes.length },
  });
  const b = (doc.buyer && typeof doc.buyer === "object" ? doc.buyer : {}) as { name?: string; nameEn?: string | null };
  await notify(tx, {
    event: "sales.qoyod_invoice_ready", dedupeKey: `${doc.id}:v${row.version}`, actorId: input.actorId,
    people: await repsOf(tx, doc),
    facts: { invoiceId: doc.id, number: doc.number ?? "", qoyodNumber: number, customerName: b.name ?? "", customerNameEn: b.nameEn ?? b.name ?? "", amount: `${Number(doc.grandTotal.toString()).toFixed(2)} SAR` },
    entity: { type: "SalesInvoice", id: doc.id },
  });
  return { id: row.id, version: row.version, replayed: false };
}

export type ChannelOutcome = { channel: "whatsapp" | "email"; status: string; note: string | null; test: boolean };

/** «إرسال»: queue Qoyod's PDF to the customer on the chosen channels. Returns what each channel will do. */
export async function sendQoyodCopy(tx: Tx, input: { invoiceId: string; channels: { whatsapp: boolean; email: boolean }; actor: { id: string; name: string } }): Promise<{ outcomes: ChannelOutcome[]; queued: number }> {
  if (!input.channels.whatsapp && !input.channels.email) throw refuse(400, "NO_CHANNEL", "اختر واتساب أو الإيميل.", "Choose WhatsApp or e-mail.");
  const doc = await tx.salesInvoice.findUnique({ where: { id: input.invoiceId }, select: HEAD });
  if (!doc) throw refuse(404, "NOT_FOUND", "غير موجود.", "Not found.");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`qoyod:copy:${doc.id}`}, 0))`;
  const copy = await tx.salesInvoiceQoyod.findUnique({ where: { invoiceId: doc.id }, select: { id: true, qoyodNumber: true, version: true, sendCount: true } });
  if (!copy) throw refuse(409, "NO_QOYOD_COPY", "ما أُرفقت فاتورة قيود على هذا المستند بعد — يرفعها المحاسب أولًا.", "Qoyod's invoice is not attached yet.");
  if (doc.status !== "ISSUED") throw refuse(409, "NOT_ISSUED", "المستند غير صادر.", "The document is not issued.");
  // A send still waiting is not doubled by a second press.
  const waiting = await Promise.all([
    tx.whatsAppMessage.count({ where: { attachmentKind: "qoyod_pdf", attachmentRefId: copy.id, status: { in: ["QUEUED", "SENDING"] } } }),
    tx.emailMessage.count({ where: { attachmentKind: "qoyod_pdf", attachmentRefId: copy.id, status: { in: ["QUEUED", "SENDING"] } } }),
  ]);
  if (waiting[0] + waiting[1] > 0) throw refuse(409, "ALREADY_WAITING", "الإرسال السابق لهذه الفاتورة ما زال في الطابور — انتظر دقيقة ثم حدّث الصفحة.", "The previous send is still waiting.");

  const customer = await tx.customer.findUnique({ where: { id: doc.customerId }, select: { id: true, name: true, nameAr: true, phone: true, whatsappOptOut: true, email: true, emailOptOut: true } });
  if (!customer) throw refuse(409, "NO_CUSTOMER", "العميل غير موجود.", "The customer was not found.");
  const seller = await sellerSnapshot(tx);
  const company = String((seller as { name?: string | null }).name || "حِقبة");
  const msg = qoyodMessage({ customerName: customer.nameAr || customer.name, qoyodNumber: copy.qoyodNumber, total: doc.grandTotal.toString(), company, kind: doc.kind });
  const sendNo = copy.sendCount + 1;
  const now = new Date();
  const common = { ruleId: null, ruleName: RULE_NAME, eventType: QOYOD_EVENT, subjectType: "SalesInvoice", subjectId: doc.id, recipientKind: "customer", recipientName: customer.nameAr || customer.name, scheduledAt: now, createdById: input.actor.id, attachmentKind: "qoyod_pdf", attachmentRefId: copy.id };
  const outcomes: ChannelOutcome[] = [];

  if (input.channels.whatsapp) {
    const mode = effectiveMode(await readSettings(tx));
    const d = planDelivery({ phone: customer.phone, optOut: customer.whatsappOptOut }, mode);
    await tx.whatsAppMessage.create({
      data: { ...common, dedupeKey: qoyodDedupeKey(copy.id, copy.version, sendNo, customer.id, "whatsapp"), phone: d.phone, intendedPhone: d.intendedPhone, body: msg.body, status: d.status, statusNote: d.statusNote ?? `Sent by hand by ${input.actor.name}.` },
    });
    outcomes.push({ channel: "whatsapp", status: d.status, note: d.statusNote, test: mode.mode === "TEST" });
  }
  if (input.channels.email) {
    const mode = await currentEmailMode(tx);
    const suppressed = await suppressionLookup(tx, [customer.email]);
    const d = planEmailDelivery({ key: `customer:${customer.id}`, name: customer.nameAr || customer.name, email: customer.email, optOut: customer.emailOptOut }, mode, suppressed);
    await tx.emailMessage.create({
      data: { ...common, dedupeKey: qoyodDedupeKey(copy.id, copy.version, sendNo, customer.id, "email"), customerId: customer.id, toEmail: d.toEmail, intendedEmail: d.intendedEmail, planMode: mode.mode, subject: msg.subject, bodyText: msg.body, status: d.status, statusNote: d.statusNote ?? `Sent by hand by ${input.actor.name}.` },
    });
    outcomes.push({ channel: "email", status: d.status, note: d.statusNote, test: mode.mode === "TEST" });
  }
  const queued = outcomes.filter((o) => o.status === "QUEUED").length;
  // Every press is counted (its rows hold this number in their keys), whether or not a channel could go.
  await tx.salesInvoiceQoyod.update({ where: { id: copy.id }, data: { sendCount: sendNo, lastSentAt: now, lastSentById: input.actor.id } });
  await audit(tx, { action: "QOYOD_INVOICE_SENT", entityType: "SalesInvoice", entityId: doc.id, actorId: input.actor.id, after: { qoyodNumber: copy.qoyodNumber, version: copy.version, sendNo, outcomes } });
  return { outcomes, queued };
}
