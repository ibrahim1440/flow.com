// Native HR — employee documents. Bytes are stored in the database (bytea), hashed, capped,
// type-checked, and every download is audited. Documents are soft-deleted, never erased.
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { HrError, type HrActor, TX, assertCan, resolveScope, personInScope, audit, oneOf, reqText, text } from "../core";
import { dayString, isDay, parseDay } from "../dates";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Map([
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]], // %PDF
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
]);
const CATEGORIES = ["CONTRACT", "IDENTITY", "CERTIFICATE", "MEDICAL", "OTHER"] as const;

/** The declared type must match the file's own leading bytes: a renamed executable is refused. */
export function sniff(mime: string, bytes: Uint8Array): boolean {
  const magic = ALLOWED.get(mime);
  if (!magic) return false;
  return magic.every((b, i) => bytes[i] === b);
}

export async function uploadDocument(actor: HrActor, employeeId: string, form: FormData) {
  assertCan(actor, "documents_manage");
  const file = form.get("file");
  if (!(file instanceof File)) throw new HrError("file is required.", 400);
  if (file.size <= 0) throw new HrError("The file is empty.", 400);
  if (file.size > MAX_DOCUMENT_BYTES) throw new HrError("Files are limited to 5 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniff(file.type, bytes)) throw new HrError("Only PDF, PNG or JPEG files whose content matches their type are accepted.", 415);
  const category = oneOf(form.get("category"), "category", CATEGORIES, "OTHER");
  const title = reqText(form.get("title"), "title", 120);
  const expires = form.get("expiresOn");
  if (expires && !isDay(expires)) throw new HrError("expiresOn must be a date.", 400);
  const confidential = form.get("confidential") !== "false";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, employeeId);
    const doc = await tx.hrDocument.create({
      data: {
        employeeId, category, title, fileName: (text(file.name, "fileName", { max: 200 }) ?? "document").replace(/[\\/:*?"<>|]+/g, "_"),
        mimeType: file.type, sizeBytes: bytes.length, sha256, content: bytes, confidential,
        expiresOn: typeof expires === "string" && expires ? parseDay(expires) : null, uploadedBy: actor.id,
      },
      select: { id: true, category: true, title: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true, confidential: true, expiresOn: true, createdAt: true },
    });
    await audit(tx, { action: "DOCUMENT_UPLOAD", entityType: "HrDocument", entityId: doc.id, employeeId, after: { title, category, sizeBytes: bytes.length, sha256 }, actorId: actor.id });
    return { ...doc, expiresOn: doc.expiresOn ? dayString(doc.expiresOn) : null };
  }, TX);
}

export async function downloadDocument(actor: HrActor, employeeId: string, docId: string) {
  assertCan(actor, "documents_view");
  return prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, employeeId);
    const doc = await tx.hrDocument.findFirst({ where: { id: docId, employeeId, deletedAt: null } });
    if (!doc) throw new HrError("Document not found", 404);
    await audit(tx, { action: "DOCUMENT_DOWNLOAD", entityType: "HrDocument", entityId: doc.id, employeeId, actorId: actor.id });
    return doc;
  }, TX);
}

export async function removeDocument(actor: HrActor, employeeId: string, docId: string, reason: string) {
  assertCan(actor, "documents_manage");
  const why = reqText(reason, "reason", 300, 3);
  return prisma.$transaction(async (tx) => {
    const scope = await resolveScope(actor, tx);
    await personInScope(tx, scope, employeeId);
    const r = await tx.hrDocument.updateMany({ where: { id: docId, employeeId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: actor.id } });
    if (r.count !== 1) throw new HrError("Document not found", 404);
    await audit(tx, { action: "DOCUMENT_REMOVE", entityType: "HrDocument", entityId: docId, employeeId, reason: why, actorId: actor.id });
    return { removed: true };
  }, TX);
}
