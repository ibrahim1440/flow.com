// Direct browser-to-Blob uploads of customer files — the server side (feat/blob-client-upload). The
// rules (sizes, scope, windows, messages) are ./direct-upload-rules.ts; the flow is described there.
//
// ── Who may ──
// The same gate as the app's own upload route (customers at edit), PLUS the sales-rep ownership
// scope the order actions already apply (services/orders/owner-access.ts isScopedSalesRep): a rep
// who sees only their own customers (the sales module without lead_assign) may upload only to a
// customer they are the account owner of — anyone else's customer reads as not found. A station
// session never gets a token (it is refused before any of this: lib/auth-server, and again here).
//
// ── Orphans ──
// A slot handed out and never finalized is an orphan after ORPHAN_AGE_MS (1 h): sweepOrphanUploads
// deletes its blob (if any) and the slot. It runs after every prepare and finalize (bounded, at most
// once a minute per instance, never delaying the response) and on demand from the administrator
// (POST /api/admin/customer-files/orphans). Only this database's own slots are swept — never a
// listing of the store — so a preview sharing the store with production cannot delete production's
// files. A failed delete keeps the slot for the next sweep and reports a storage incident.

import { createHash, randomBytes } from "node:crypto";
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import type { Permissions } from "@/lib/auth-shared";
import { customersScopedToOwner, ownedCustomerWhere } from "../sales/scope";
import { safeFilename } from "../sales/evidence";
import { blobPathnameFor, chooseStorage, errorCode, supportsDirectUpload, type BlobStore } from "./file-store";
import { reportStorageFailure, reportStorageSuccess } from "../system/storage-alerts";
import { CUSTOMER_FILE_CATEGORIES, CUSTOMER_FILE_SELECT, MAX_FILES_PER_CUSTOMER, type CustomerFileCategory } from "./files";
import {
  DIRECT_MESSAGES, DIRECT_TOKEN_TTL_MS, DIRECT_UPLOAD_MAX_BYTES, DIRECT_UPLOAD_TYPES, ORPHAN_AGE_MS, SERVER_UPLOAD_MAX_BYTES,
  checkBlobHead, directTokenScope, finalizeOpen, isConstraintReason, slotIdFromPathname, sniffDirectType,
  type DirectUploadType, type FailureReason,
} from "./direct-upload-rules";

type Db = PrismaClient;
export type Problem = { status: 400 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 503; code: string; error: string; errorEn: string };
const problem = (status: Problem["status"], code: string, m: { error: string; errorEn: string }): Problem => ({ status, code, ...m });
const NOT_FOUND = { error: "العميل غير موجود.", errorEn: "Not found" };
const SLOT_NOT_FOUND = { error: "عملية الرفع غير موجودة أو انتهت.", errorEn: "This upload does not exist or has ended." };

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");

/** Does this deployment offer the direct path? (A Blob store that answers head and issues tokens.) */
export function directUploadOffered(env: Record<string, string | undefined> = process.env): boolean {
  const c = chooseStorage(env);
  return c.kind === "blob" && supportsDirectUpload(c.store);
}

function directStore(): (BlobStore & Required<Pick<BlobStore, "head" | "issueUploadToken">>) | null {
  const c = chooseStorage();
  return c.kind === "blob" && supportsDirectUpload(c.store) ? c.store : null;
}
const NOT_OFFERED = problem(409, "DIRECT_UPLOAD_UNAVAILABLE", {
  error: "الرفع المباشر غير متاح على هذا الخادم: الملفات حتى 4 ميغابايت تُرفع كالمعتاد.",
  errorEn: "Direct upload is not available on this server: files up to 4 MB upload as usual.",
});

/**
 * The customer, if `user` may change its files: it exists, and a scoped rep is its account owner.
 * Not found otherwise (a rep learns nothing about another rep's customer).
 */
export async function editableCustomer(
  db: Db,
  user: { id: string; role?: string | null; permissions: Permissions; scope?: unknown },
  customerId: string,
): Promise<{ ok: true; customer: { id: string; fileCount: number } } | { ok: false; problem: Problem }> {
  if (user.scope === "STATION") return { ok: false, problem: problem(403, "STATION_REFUSED", { error: "لا يُتاح رفع ملفات العملاء من جهاز محطة.", errorEn: "Customer files cannot be uploaded from a station." }) };
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, accountOwnerId: true, _count: { select: { files: true } } } });
  if (!c) return { ok: false, problem: problem(404, "NOT_FOUND", NOT_FOUND) };
  // The customer is in the viewer's book (services/sales/scope.ts — the one predicate, council gate S4).
  if (customersScopedToOwner(user) && !(await db.customer.findFirst({ where: { id: customerId, ...ownedCustomerWhere(user.id) }, select: { id: true } }))) {
    return { ok: false, problem: problem(404, "NOT_FOUND", NOT_FOUND) };
  }
  return { ok: true, customer: { id: c.id, fileCount: c._count.files } };
}

const newSlotId = () => `cf${randomBytes(12).toString("hex")}`;

/**
 * 1 — hand out one upload slot. The browser declares name, size and type (sniffed from the file's
 * first bytes); none of it is trusted later, finalize reads the blob itself.
 */
export async function prepareDirectUpload(
  db: Db,
  input: { customerId: string; fileCount: number; userId: string; fileName: unknown; size: unknown; contentType: unknown; category: unknown; title: unknown; now?: Date },
): Promise<{ ok: true; slot: { uploadId: string; pathname: string; contentType: DirectUploadType; maxBytes: number; tokenExpiresAt: Date } } | { ok: false; problem: Problem }> {
  if (!directStore()) return { ok: false, problem: NOT_OFFERED };
  const now = input.now ?? new Date();
  const category = (typeof input.category === "string" && input.category ? input.category : "OTHER") as CustomerFileCategory;
  if (!CUSTOMER_FILE_CATEGORIES.includes(category)) return { ok: false, problem: problem(400, "BAD_CATEGORY", { error: "تصنيف الملف غير معروف.", errorEn: "Unknown file category." }) };
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : -1;
  if (size <= 0) return { ok: false, problem: problem(400, "EMPTY", { error: "الملف فارغ.", errorEn: "That file is empty." }) };
  if (size > DIRECT_UPLOAD_MAX_BYTES) return { ok: false, problem: problem(413, "TOO_LARGE", DIRECT_MESSAGES.TOO_LARGE) };
  if (size <= SERVER_UPLOAD_MAX_BYTES) {
    return { ok: false, problem: problem(400, "USE_SERVER_UPLOAD", { error: "الملفات حتى 4 ميغابايت تُرفع عبر الخادم.", errorEn: "Files up to 4 MB upload through the server." }) };
  }
  const contentType = input.contentType as DirectUploadType;
  if (!(DIRECT_UPLOAD_TYPES as readonly string[]).includes(contentType)) return { ok: false, problem: problem(415, "UNSUPPORTED_TYPE", DIRECT_MESSAGES.UNSUPPORTED_TYPE) };
  // Slots whose token is still valid hold a place (a failed attempt stops counting after 10 minutes;
  // the slot itself stays until the sweep, so a replayed upload URL never leaves an untracked blob).
  const live = await db.customerFileUpload.count({ where: { customerId: input.customerId, tokenExpiresAt: { gt: now } } });
  if (input.fileCount + live >= MAX_FILES_PER_CUSTOMER) {
    return { ok: false, problem: problem(409, "TOO_MANY_FILES", { error: `بلغ ملف العميل الحد الأقصى (${MAX_FILES_PER_CUSTOMER} ملفًا). احذف ملفًا قديمًا أولًا.`, errorEn: `The customer file holds at most ${MAX_FILES_PER_CUSTOMER} documents.` }) };
  }
  const fileName = clean(input.fileName).slice(0, 200) || "file";
  const id = newSlotId();
  // The pathname's extension follows the declared (sniffed) type; the stored name follows the bytes.
  const pathname = blobPathnameFor(input.customerId, id, safeFilename(fileName, contentType));
  const tokenExpiresAt = new Date(now.getTime() + DIRECT_TOKEN_TTL_MS);
  await db.customerFileUpload.create({
    data: {
      id, customerId: input.customerId, pathname, category, title: clean(input.title).slice(0, 120) || null, fileName,
      declaredBytes: size, declaredType: contentType, requestedById: input.userId, createdAt: now, tokenExpiresAt,
    },
  });
  return { ok: true, slot: { uploadId: id, pathname, contentType, maxBytes: DIRECT_UPLOAD_MAX_BYTES, tokenExpiresAt } };
}

/**
 * 2 — the token for the SDK's presigned PUT: only for a live slot of this customer that this user
 * asked for, and only for its exact pathname. Blob down → an incident and a clear refusal.
 */
export async function issueDirectUploadToken(
  db: Db,
  input: { customerId: string; userId: string; pathname: string; now?: Date },
): Promise<{ ok: true; token: { delegationToken: string; clientSigningToken: string; validUntil: number }; urlOptions: ReturnType<typeof directTokenScope>["urlOptions"]; slotId: string } | { ok: false; problem: Problem }> {
  const store = directStore();
  if (!store) return { ok: false, problem: NOT_OFFERED };
  const now = input.now ?? new Date();
  const slotId = slotIdFromPathname(input.pathname, input.customerId);
  if (!slotId) return { ok: false, problem: problem(404, "NOT_FOUND", SLOT_NOT_FOUND) };
  const slot = await db.customerFileUpload.findUnique({ where: { id: slotId }, select: { customerId: true, pathname: true, requestedById: true, tokenExpiresAt: true } });
  if (!slot || slot.customerId !== input.customerId || slot.pathname !== input.pathname || slot.requestedById !== input.userId) {
    return { ok: false, problem: problem(404, "NOT_FOUND", SLOT_NOT_FOUND) };
  }
  if (slot.tokenExpiresAt.getTime() <= now.getTime()) return { ok: false, problem: problem(410, "EXPIRED", DIRECT_MESSAGES.EXPIRED) };
  const scope = directTokenScope(slot.pathname, now.getTime());
  // Never past the slot's own token window.
  const validUntil = Math.min(scope.delegation.validUntil, slot.tokenExpiresAt.getTime());
  try {
    const token = await store.issueUploadToken({ ...scope.delegation, validUntil });
    return { ok: true, token, urlOptions: { ...scope.urlOptions, validUntil }, slotId };
  } catch (e) {
    await reportStorageFailure(db, "UPLOAD_FAILED", errorCode(e), "REFUSED");
    return { ok: false, problem: problem(503, "STORAGE_UNAVAILABLE", DIRECT_MESSAGES.STORAGE_UNAVAILABLE) };
  }
}

/** Read a blob once: its length (capped), SHA-256 and the type its first bytes prove. */
export async function inspectBlobStream(stream: ReadableStream<Uint8Array>, maxBytes = DIRECT_UPLOAD_MAX_BYTES): Promise<{ size: number; sha256: string; type: DirectUploadType | null; overLimit: boolean }> {
  const hash = createHash("sha256");
  const headBytes = new Uint8Array(8);
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (size < headBytes.length) headBytes.set(value.subarray(0, headBytes.length - size), size);
      size += value.length;
      if (size > maxBytes) { await reader.cancel().catch(() => undefined); return { size, sha256: "", type: null, overLimit: true }; }
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, sha256: hash.digest("hex"), type: sniffDirectType(headBytes.subarray(0, Math.min(size, headBytes.length))), overLimit: false };
}

type FileRow = PrismaNS.CustomerFileGetPayload<{ select: typeof CUSTOMER_FILE_SELECT }>;

/**
 * 4 — the source of truth. head() with the server's own credentials, the size and type rules, one
 * streamed read (SHA-256 + magic bytes: the type is the bytes'), then the row — which takes the slot's
 * id, so the same pathname can never make two rows (unique id and unique blobPathname). A repeated
 * finalize returns the row it already made (`duplicate`). A blob that fails the checks is deleted.
 * `actorId` null = the signed upload-completed webhook.
 */
export async function finalizeDirectUpload(
  db: Db,
  input: { customerId: string; uploadId: string; actorId: string | null; now?: Date },
): Promise<{ ok: true; row: FileRow; duplicate: boolean } | { ok: false; problem: Problem }> {
  const now = input.now ?? new Date();
  const already = () => db.customerFile.findFirst({ where: { id: input.uploadId, customerId: input.customerId }, select: CUSTOMER_FILE_SELECT });
  const slot = await db.customerFileUpload.findUnique({ where: { id: input.uploadId } });
  if (!slot || slot.customerId !== input.customerId) {
    // Already finalized (by this request's twin, or by the webhook): the same row, never a second one.
    const row = await already();
    if (row) return { ok: true, row, duplicate: true };
    return { ok: false, problem: problem(404, "NOT_FOUND", SLOT_NOT_FOUND) };
  }
  if (input.actorId !== null && slot.requestedById !== input.actorId) return { ok: false, problem: problem(404, "NOT_FOUND", SLOT_NOT_FOUND) };
  const store = directStore();
  if (!store) return { ok: false, problem: NOT_OFFERED };
  const reject = async (status: 410 | 413 | 415 | 422, code: string, m: { error: string; errorEn: string }) => {
    try {
      await store.del([slot.pathname]);
      await db.customerFileUpload.deleteMany({ where: { id: slot.id } });
    } catch (e) {
      // The slot stays: the sweep deletes the blob later.
      await reportStorageFailure(db, "DELETE_FAILED", errorCode(e), "NONE");
    }
    return { ok: false as const, problem: problem(status, code, m) };
  };
  if (!finalizeOpen(slot.createdAt, now)) return reject(410, "EXPIRED", DIRECT_MESSAGES.EXPIRED);

  let head: Awaited<ReturnType<typeof store.head>>;
  let inspected: Awaited<ReturnType<typeof inspectBlobStream>> | null = null;
  try {
    head = await store.head(slot.pathname);
    const check = checkBlobHead(head, slot.declaredBytes);
    if (!check.ok) {
      if (check.code === "BLOB_MISSING") {
        return { ok: false, problem: problem(409, "NOT_UPLOADED", { error: "لم يصل الملف إلى المخزن بعد. أعد المحاولة.", errorEn: "The file has not reached storage yet. Try again." }) };
      }
      await reportStorageSuccess(db);
      if (check.code === "TOO_LARGE") return reject(413, "TOO_LARGE", DIRECT_MESSAGES.TOO_LARGE);
      if (check.code === "UNSUPPORTED_TYPE") return reject(415, "UNSUPPORTED_TYPE", DIRECT_MESSAGES.UNSUPPORTED_TYPE);
      return reject(422, check.code, DIRECT_MESSAGES.REJECTED);
    }
    const got = await store.get(slot.pathname);
    if (got) inspected = await inspectBlobStream(got.stream);
  } catch (e) {
    await reportStorageFailure(db, "UPLOAD_FAILED", errorCode(e), "REFUSED");
    return { ok: false, problem: problem(503, "STORAGE_UNAVAILABLE", DIRECT_MESSAGES.STORAGE_UNAVAILABLE) };
  }
  await reportStorageSuccess(db);
  if (!inspected) return { ok: false, problem: problem(409, "NOT_UPLOADED", { error: "لم يصل الملف إلى المخزن بعد. أعد المحاولة.", errorEn: "The file has not reached storage yet. Try again." }) };
  if (inspected.overLimit) return reject(413, "TOO_LARGE", DIRECT_MESSAGES.TOO_LARGE);
  if (!inspected.type) return reject(415, "UNSUPPORTED_TYPE", DIRECT_MESSAGES.UNSUPPORTED_TYPE);
  if (inspected.size !== head!.size) return reject(422, "SIZE_MISMATCH", DIRECT_MESSAGES.REJECTED);

  const fileName = safeFilename(clean(slot.fileName) || "file", inspected.type);
  const title = (clean(slot.title) || fileName.replace(/\.[a-z]+$/, "")).slice(0, 120);
  try {
    const row = await db.$transaction(async (tx) => {
      // Claims the slot: a concurrent finalize (or the sweep) that got here first leaves 0.
      const gone = await tx.customerFileUpload.deleteMany({ where: { id: slot.id, customerId: slot.customerId } });
      if (gone.count !== 1) throw new SlotTaken();
      return tx.customerFile.create({
        data: {
          id: slot.id, customerId: slot.customerId, category: slot.category, title, fileName, mimeType: inspected.type!,
          sizeBytes: inspected.size, sha256: inspected.sha256, blobPathname: slot.pathname, uploadedById: slot.requestedById,
        },
        select: CUSTOMER_FILE_SELECT,
      });
    });
    return { ok: true, row, duplicate: false };
  } catch (e) {
    if (e instanceof SlotTaken || (e as { code?: string })?.code === "P2002") {
      const row = await already();
      if (row) return { ok: true, row, duplicate: true };
      return { ok: false, problem: problem(410, "EXPIRED", DIRECT_MESSAGES.EXPIRED) };
    }
    throw e;
  }
}
class SlotTaken extends Error {}

/**
 * The browser's upload failed. Its own reason for a constraint (too large, wrong type, expired) is
 * answered as such. Anything else is checked from the server: the store answers → the blob may be
 * there after all (`uploaded`: finalize) or the browser's line dropped (NETWORK, no incident); the
 * store does not answer → the existing storage incident (UPLOAD_FAILED, refused) and a clear refusal:
 * there is no database fallback for a file over 4 MB.
 */
export async function reportDirectUploadFailure(
  db: Db,
  input: { customerId: string; uploadId: string; actorId: string; reason: FailureReason },
): Promise<{ ok: true; uploaded: true } | { ok: false; problem: Problem }> {
  const slot = await db.customerFileUpload.findUnique({ where: { id: input.uploadId }, select: { customerId: true, pathname: true, requestedById: true } });
  if (!slot || slot.customerId !== input.customerId || slot.requestedById !== input.actorId) return { ok: false, problem: problem(404, "NOT_FOUND", SLOT_NOT_FOUND) };
  if (isConstraintReason(input.reason)) {
    if (input.reason === "TOO_LARGE") return { ok: false, problem: problem(413, "TOO_LARGE", DIRECT_MESSAGES.TOO_LARGE) };
    if (input.reason === "TYPE") return { ok: false, problem: problem(415, "UNSUPPORTED_TYPE", DIRECT_MESSAGES.UNSUPPORTED_TYPE) };
    if (input.reason === "EXPIRED") return { ok: false, problem: problem(410, "EXPIRED", DIRECT_MESSAGES.EXPIRED) };
    return { ok: false, problem: problem(409, "ABORTED", { error: "أُلغي الرفع.", errorEn: "The upload was cancelled." }) };
  }
  const store = directStore();
  if (!store) return { ok: false, problem: NOT_OFFERED };
  try {
    const h = await store.head(slot.pathname);
    await reportStorageSuccess(db);
    if (h) return { ok: true, uploaded: true };
    return { ok: false, problem: problem(409, "NETWORK", DIRECT_MESSAGES.NETWORK) };
  } catch (e) {
    await reportStorageFailure(db, "UPLOAD_FAILED", errorCode(e), "REFUSED");
    return { ok: false, problem: problem(503, "STORAGE_UNAVAILABLE", DIRECT_MESSAGES.STORAGE_UNAVAILABLE) };
  }
}

/**
 * Delete orphans: slots older than ORPHAN_AGE_MS (never finalized) — their blob, then the slot.
 * Bounded (`limit`). A failed delete keeps the slot (next sweep) and reports the incident.
 */
export async function sweepOrphanUploads(db: Db, opts: { now?: Date; limit?: number } = {}): Promise<{ swept: number; failed: number; remaining: boolean }> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const cutoff = new Date(now.getTime() - ORPHAN_AGE_MS);
  const old = await db.customerFileUpload.findMany({ where: { createdAt: { lt: cutoff } }, orderBy: { createdAt: "asc" }, take: limit + 1, select: { id: true, pathname: true } });
  const batch = old.slice(0, limit);
  if (batch.length === 0) return { swept: 0, failed: 0, remaining: false };
  const c = chooseStorage();
  if (c.kind !== "blob") return { swept: 0, failed: batch.length, remaining: old.length > limit };
  // A blob row that already exists for a slot (a crash between commit steps cannot leave one, but a
  // file must never lose its bytes to the sweep): never delete a pathname a CustomerFile row holds.
  const kept = new Set((await db.customerFile.findMany({ where: { blobPathname: { in: batch.map((b) => b.pathname) } }, select: { blobPathname: true } })).map((r) => r.blobPathname));
  try {
    const toDelete = batch.filter((b) => !kept.has(b.pathname)).map((b) => b.pathname);
    if (toDelete.length) await c.store.del(toDelete);
  } catch (e) {
    await reportStorageFailure(db, "DELETE_FAILED", errorCode(e), "NONE");
    return { swept: 0, failed: batch.length, remaining: true };
  }
  const gone = await db.customerFileUpload.deleteMany({ where: { id: { in: batch.map((b) => b.id) }, createdAt: { lt: cutoff } } });
  return { swept: gone.count, failed: 0, remaining: old.length > limit };
}

let lastSweep = 0;
/** The cheap background sweep: at most once a minute per instance; never throws. */
export async function maybeSweepOrphans(db: Db, now = Date.now()): Promise<void> {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  await sweepOrphanUploads(db, { limit: 50 }).catch(() => undefined);
}
/** Tests reset the throttle. */
export function resetSweepThrottleForTests() { lastSweep = 0; }
