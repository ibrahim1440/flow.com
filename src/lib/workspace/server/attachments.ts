// «مساحة عملي» — files on a task. The type is decided by the bytes (the collection-evidence sniffer:
// PDF, JPEG, PNG), never the name or the browser's claim; at most 5 MB, kept in the row (CHECK), 10 per
// task. Read only by the people who may see the task, served as a download (no inline rendering).
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { MAX_EVIDENCE_BYTES, safeFilename, sniffEvidenceType, evidenceHeaders } from "@/lib/services/sales/evidence";
import { canDo } from "../rules";
import { forbidden, notFound, rolesOf, teamCtx, wsError, type WsActor } from "./context";

export const MAX_ATTACHMENTS = 10;
const PEOPLE = { assigneeId: true, createdById: true, reviewerId: true, status: true, watchers: { select: { employeeId: true } } } as const;

async function taskFor(actor: WsActor, taskId: string) {
  const t = await prisma.workTask.findUnique({ where: { id: taskId }, select: PEOPLE });
  const ctx = await teamCtx(prisma, actor);
  if (!t || !canDo("view", rolesOf(actor.id, t, ctx))) throw notFound();
  return { t, roles: rolesOf(actor.id, t, ctx) };
}

export async function listAttachments(actor: WsActor, taskId: string) {
  await taskFor(actor, taskId);
  return prisma.workTaskAttachment.findMany({ where: { taskId }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } });
}

export async function addAttachment(actor: WsActor, taskId: string, file: File | null) {
  const { t, roles } = await taskFor(actor, taskId);
  if (!canDo("comment", roles)) throw forbidden();
  if (t.status === "DONE" || t.status === "CANCELLED") throw wsError(409, "المهمة مغلقة.", "The task is closed.", "CLOSED");
  if (!file || typeof file.arrayBuffer !== "function") throw wsError(400, "أرفق ملفًا.", "A file is required.", "FILE_REQUIRED");
  if (file.size > MAX_EVIDENCE_BYTES) throw wsError(413, "الحد الأقصى لحجم الملف 5 ميغابايت.", "Files are limited to 5 MB.", "TOO_LARGE");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) throw wsError(400, "الملف فارغ.", "The file is empty.", "FILE_EMPTY");
  const mimeType = sniffEvidenceType(bytes);
  if (!mimeType) throw wsError(415, "الملفات المقبولة: PDF أو JPEG أو PNG.", "Accepted files: PDF, JPEG, PNG.", "TYPE_REFUSED");
  if ((await prisma.workTaskAttachment.count({ where: { taskId } })) >= MAX_ATTACHMENTS) throw wsError(409, "بلغت المرفقات حدها (10).", "Attachment limit reached.", "TOO_MANY");
  const a = await prisma.$transaction(async (tx) => {
    const row = await tx.workTaskAttachment.create({
      data: { taskId, fileName: safeFilename(file.name, mimeType), mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes, uploadedById: actor.id },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    await tx.workTaskEvent.create({ data: { taskId, actorId: actor.id, action: "UPDATED", data: { attachment: { id: row.id, fileName: row.fileName } } } });
    return row;
  });
  return a;
}

export async function openAttachment(actor: WsActor, taskId: string, id: string): Promise<Response> {
  await taskFor(actor, taskId);
  const a = await prisma.workTaskAttachment.findFirst({ where: { id, taskId } });
  if (!a) throw notFound();
  return new Response(new Uint8Array(a.content), { headers: evidenceHeaders({ filename: a.fileName, mimeType: a.mimeType, byteSize: a.sizeBytes }) });
}

/** The uploader, or the task's asker / manager, while the task is open. */
export async function removeAttachment(actor: WsActor, taskId: string, id: string) {
  const { t, roles } = await taskFor(actor, taskId);
  const a = await prisma.workTaskAttachment.findFirst({ where: { id, taskId }, select: { uploadedById: true, fileName: true } });
  if (!a) throw notFound();
  if (a.uploadedById !== actor.id && !canDo("edit", roles)) throw forbidden();
  if (t.status === "DONE" || t.status === "CANCELLED") throw wsError(409, "المهمة مغلقة.", "The task is closed.", "CLOSED");
  await prisma.$transaction([
    prisma.workTaskAttachment.delete({ where: { id } }),
    prisma.workTaskEvent.create({ data: { taskId, actorId: actor.id, action: "UPDATED", data: { attachmentRemoved: { id, fileName: a.fileName } } } }),
  ]);
  return { ok: true };
}
