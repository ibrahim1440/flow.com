// «المرفقات» of a purchase invoice (BATCH22 WP-H): the receipt / tax-invoice image a simple invoice must carry (the
// audit evidence of the expense, and ZATCA's condition for the VAT claim), available on every purchase invoice. The bytes
// live in the generic "FinAttachment" (entityType SUPPLIER_INVOICE). The type is proven by the file's signature — never
// the browser's Content-Type or the name (the collection-evidence rule, src/lib/services/sales/evidence.ts): JPEG, PNG
// or PDF, at most 10 MB. An attachment is never deleted once its invoice is posted (it is what the posting rests on).
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { sniffEvidenceType } from "@/lib/services/sales/evidence";
import { opsRefuse } from "./refusals";
import { setAuditContext, type AuditContext } from "../audit";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const INVOICE_ATTACHMENT_ENTITY = "SUPPLIER_INVOICE";
export const MAX_INVOICE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachmentFile = { bytes: Uint8Array; fileName: string };
export type CleanAttachment = { content: Buffer; contentType: string; sizeBytes: number; fileName: string; sha256: string };

/** Pure: the file checked (size, signature) and named safely, or a coded refusal. */
export function cleanAttachment(f: AttachmentFile | null | undefined): CleanAttachment {
  if (!f || !f.bytes || f.bytes.length === 0) throw opsRefuse("SIMPLE_ATTACHMENT");
  if (f.bytes.length > MAX_INVOICE_ATTACHMENT_BYTES) throw opsRefuse("SIMPLE_ATTACHMENT", "(larger than 10 MB)", "(أكبر من 10 ميغابايت)");
  const contentType = sniffEvidenceType(f.bytes);
  if (!contentType) throw opsRefuse("SIMPLE_ATTACHMENT", "(not a JPEG, PNG or PDF by its contents)", "(ليس JPEG أو PNG أو PDF بحسب محتواه)");
  const ext = contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
  const base = String(f.fileName ?? "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "").trim().slice(0, 120) || "receipt";
  const fileName = /\.(pdf|png|jpe?g)$/i.test(base) ? base : `${base}.${ext}`;
  const content = Buffer.from(f.bytes);
  return { content, contentType, sizeBytes: content.length, fileName, sha256: createHash("sha256").update(content).digest("hex") };
}

export async function addInvoiceAttachment(tx: Tx, invoiceId: string, a: CleanAttachment, actorId: string) {
  return tx.finAttachment.create({
    data: { entityType: INVOICE_ATTACHMENT_ENTITY, entityId: invoiceId, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, content: new Uint8Array(a.content), createdBy: actorId },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, createdBy: true },
  });
}

/** The invoice's attachments (metadata only — the bytes have their own route). */
export async function invoiceAttachments(db: Db, invoiceId: string) {
  return db.finAttachment.findMany({ where: { entityType: INVOICE_ATTACHMENT_ENTITY, entityId: invoiceId }, orderBy: { createdAt: "asc" }, select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, createdBy: true } });
}

export async function attachmentCount(db: Db, invoiceId: string): Promise<number> {
  return db.finAttachment.count({ where: { entityType: INVOICE_ATTACHMENT_ENTITY, entityId: invoiceId } });
}

/** One attachment with its bytes, if it belongs to that invoice. */
export async function invoiceAttachment(invoiceId: string, attachmentId: string) {
  const a = await prisma.finAttachment.findUnique({ where: { id: attachmentId } });
  if (!a || a.entityType !== INVOICE_ATTACHMENT_ENTITY || a.entityId !== invoiceId) throw opsRefuse("OPS_NOT_FOUND");
  return a;
}

/**
 * Remove an attachment of an invoice still being prepared (DRAFT / SUBMITTED). Once the invoice is posted or cancelled —
 * or, for a simple invoice, was ever posted — its evidence is kept: the box-7 claim and the expense rest on it (BATCH22
 * gate S2; the database refuses it too: fin_attachment_evidence_guard, AP_EVIDENCE_KEPT). The delete is written to the
 * accounting audit log with its metadata only (id, entity, file name, size, sha256) — never the bytes.
 */
export async function removeInvoiceAttachment(invoiceId: string, attachmentId: string, ctx?: AuditContext) {
  return prisma.$transaction(async (tx) => {
    if (ctx) await setAuditContext(tx, ctx);
    const inv = await tx.supplierInvoice.findUnique({ where: { id: invoiceId }, select: { status: true, kind: true, postedAt: true } });
    if (!inv) throw opsRefuse("OPS_NOT_FOUND");
    if (inv.status !== "DRAFT" && inv.status !== "SUBMITTED") throw opsRefuse("INVOICE_STATE", "A posted or cancelled invoice keeps its attachments.", "الفاتورة المرحّلة أو الملغاة تحتفظ بمرفقاتها.");
    if (inv.kind === "SIMPLE" && inv.postedAt) throw opsRefuse("INVOICE_STATE", "A simple invoice that was posted keeps its receipt.", "الفاتورة البسيطة التي رُحّلت تحتفظ بإيصالها.");
    const a = await tx.finAttachment.findUnique({ where: { id: attachmentId }, select: { entityType: true, entityId: true, fileName: true, sizeBytes: true, content: true, contentType: true } });
    if (!a || a.entityType !== INVOICE_ATTACHMENT_ENTITY || a.entityId !== invoiceId) throw opsRefuse("OPS_NOT_FOUND");
    if (inv.kind === "SIMPLE" && (await attachmentCount(tx, invoiceId)) <= 1) throw opsRefuse("SIMPLE_ATTACHMENT", "(a simple invoice keeps at least one)", "(الفاتورة البسيطة تحتفظ بمرفق واحد على الأقل)");
    const sha256 = createHash("sha256").update(Buffer.from(a.content)).digest("hex");
    await tx.finAttachment.delete({ where: { id: attachmentId } });
    await tx.accountingAuditLog.create({ data: {
      actorId: ctx?.actorId ?? null, action: "ATTACHMENT_DELETED", entityType: "FinAttachment", entityId: attachmentId, reason: ctx?.reason ?? null, ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null,
      before: { entityType: a.entityType, entityId: a.entityId, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, sha256 },
    } });
    return { id: attachmentId, removed: true };
  });
}
