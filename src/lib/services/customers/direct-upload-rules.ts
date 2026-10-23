// Direct browser-to-Blob uploads of customer files (feat/blob-client-upload) — the RULES, pure and
// safe to import from the browser (no node:*, no database, no SDK). The server code that applies them
// is ./direct-upload.ts; the routes are /api/customers/[id]/files/direct{,/token,/finalize,/failed}.
//
// ── Why ──
// Vercel refuses a request body over 4.5 MB before the app sees it, so the app's own upload route
// (POST /api/customers/[id]/files) cannot carry the 20 MB the Blob store allows. Owner decision: a
// file over 4 MB goes from the browser straight to the private Blob store, with a token the server
// scopes to that one upload; a file of at most 4 MB keeps the app's route (which also has the
// database fallback when Blob is down).
//
// ── The flow ──
//   1. prepare   POST …/files/direct            the server checks the request (permission, count,
//                                               size, declared type) and hands out ONE slot: a
//                                               CustomerFileUpload row and its exact pathname;
//   2. token     POST …/files/direct/token      @vercel/blob/client uploadPresigned() asks for a
//                                               presigned PUT; the server issues it only for a live
//                                               slot of this customer, this pathname, scoped below;
//   3. upload    the browser PUTs the bytes to Blob (progress bar);
//   4. finalize  POST …/files/direct/finalize   the server reads the blob back (head + one stream),
//                                               decides the type by the bytes, hashes it and creates
//                                               the CustomerFile row — or deletes the blob and refuses.
// The upload-completed webhook is accepted when Vercel sends it (signature checked), and runs the same
// idempotent finalize; it is never relied on (it does not reach localhost or protected previews).

/** At most this size goes through the app's own route; above it, the browser uploads directly. */
export const SERVER_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** The Blob limit (the CustomerFile CHECK and the CustomerFileUpload CHECK agree). */
export const DIRECT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const DIRECT_UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DirectUploadType = (typeof DIRECT_UPLOAD_TYPES)[number];
/** The upload token's validity: long enough for 20 MB on a slow line, short enough to be useless later. */
export const DIRECT_TOKEN_TTL_MS = 10 * 60_000;
/** A slot may be finalized for this long after it was handed out … */
export const FINALIZE_WINDOW_MS = 50 * 60_000;
/** … and is an orphan (its blob deleted, the slot removed) once it is older than this. */
export const ORPHAN_AGE_MS = 60 * 60_000;
/** The browser gives up on an upload that has made no progress for this long (the SDK retries a down store for minutes). */
export const UPLOAD_STALL_MS = 20_000;

export type UploadPath = "server" | "direct" | "too-large";

/**
 * Which way a file goes, decided by its size and what the server offers (GET …/files `limits`):
 *   ≤ 4 MB                         → the app's route (Blob, or the database fallback);
 *   > 4 MB and direct offered      → direct to Blob, up to 20 MB;
 *   > 4 MB and no direct path      → the app's route up to its own limit (the database: 5 MB);
 *   over the limit that applies    → refused before anything is sent.
 */
export function pickUploadPath(size: number, offer: { maxBytes: number; direct?: boolean }): UploadPath {
  if (offer.direct) {
    if (size > DIRECT_UPLOAD_MAX_BYTES) return "too-large";
    return size > SERVER_UPLOAD_MAX_BYTES ? "direct" : "server";
  }
  return size > offer.maxBytes ? "too-large" : "server";
}

/** The magic bytes (the same three signatures as services/sales/evidence.ts sniffEvidenceType). */
export function sniffDirectType(bytes: Uint8Array): DirectUploadType | null {
  const at = (i: number) => (i < bytes.length ? bytes[i] : -1);
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) return "application/pdf";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return "image/png";
  return null;
}

/**
 * What the token may do — exactly one pathname, put only, PDF / JPEG / PNG, ≤ 20 MB, a short
 * validity, never a random suffix, never an overwrite. `delegation` goes to issueSignedToken (the
 * store signs it); `urlOptions` to the presigned URL (signed with the delegation's key).
 */
export function directTokenScope(pathname: string, now: number) {
  const validUntil = now + DIRECT_TOKEN_TTL_MS;
  const allowedContentTypes = [...DIRECT_UPLOAD_TYPES];
  return {
    delegation: { pathname, operations: ["put" as const], validUntil, maximumSizeInBytes: DIRECT_UPLOAD_MAX_BYTES, allowedContentTypes },
    urlOptions: { addRandomSuffix: false, allowOverwrite: false, allowedContentTypes, maximumSizeInBytes: DIRECT_UPLOAD_MAX_BYTES, validUntil },
  };
}

/** customers/<customerId>/<cf + 24 hex>-<name> → the slot id, or null when it is not this customer's shape. */
export function slotIdFromPathname(pathname: string, customerId: string): string | null {
  const seg = customerId.replace(/[^A-Za-z0-9_-]/g, "_");
  const prefix = `customers/${seg}/`;
  if (!pathname.startsWith(prefix) || pathname.includes("//") || pathname.includes("..")) return null;
  const m = pathname.slice(prefix.length).match(/^(cf[0-9a-f]{24})-[A-Za-z0-9._-]{1,120}$/);
  return m ? m[1] : null;
}

/** A slot is an orphan when it was handed out more than an hour ago and never finalized. */
export function isOrphanSlot(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > ORPHAN_AGE_MS;
}
/** A slot may still be finalized (the gap to ORPHAN_AGE_MS keeps the sweep and a finalize apart). */
export function finalizeOpen(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= FINALIZE_WINDOW_MS;
}

export type BlobFacts = { size: number; contentType: string };
export type BlobCheck = { ok: true } | { ok: false; code: "BLOB_MISSING" | "EMPTY" | "TOO_LARGE" | "SIZE_MISMATCH" | "UNSUPPORTED_TYPE" };

/** head(): the blob exists, is within 20 MB, has the size the browser declared and an allowed type. */
export function checkBlobHead(head: BlobFacts | null, declaredBytes: number): BlobCheck {
  if (!head) return { ok: false, code: "BLOB_MISSING" };
  if (head.size <= 0) return { ok: false, code: "EMPTY" };
  if (head.size > DIRECT_UPLOAD_MAX_BYTES) return { ok: false, code: "TOO_LARGE" };
  if (head.size !== declaredBytes) return { ok: false, code: "SIZE_MISMATCH" };
  const ct = head.contentType.split(";")[0].trim().toLowerCase();
  if (!(DIRECT_UPLOAD_TYPES as readonly string[]).includes(ct)) return { ok: false, code: "UNSUPPORTED_TYPE" };
  return { ok: true };
}

export const FAILURE_REASONS = ["STALLED", "NETWORK", "TOKEN", "SERVICE", "TOO_LARGE", "TYPE", "EXPIRED", "ABORTED", "OTHER"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * What went wrong with the browser's upload, from the SDK's error message (class names do not
 * survive minification; the messages are @vercel/blob 2.8.2's own, src/api.ts).
 */
export function classifyUploadError(message: string, ctx: { stalled?: boolean; cancelled?: boolean } = {}): FailureReason {
  if (ctx.cancelled) return "ABORTED";
  if (ctx.stalled) return "STALLED";
  if (/File is too large|cannot be greater than/i.test(message)) return "TOO_LARGE";
  if (/Content type mismatch|contentType .* is not allowed/i.test(message)) return "TYPE";
  if (/token has expired|Token expired/i.test(message)) return "EXPIRED";
  if (/retrieve the presigned URL|presignedUrlPayload/i.test(message)) return "TOKEN";
  if (/not available|Unknown error|Too many requests|store does not exist|suspended/i.test(message)) return "SERVICE";
  if (/Network request failed|Failed to fetch|NetworkError|timed out|Load failed/i.test(message)) return "NETWORK";
  return "OTHER";
}

/** Reasons that are the token's constraints doing their job — never an outage, never an incident. */
export function isConstraintReason(r: FailureReason): boolean {
  return r === "TOO_LARGE" || r === "TYPE" || r === "EXPIRED" || r === "ABORTED";
}

/** The refusals the browser shows (Arabic first, as every refusal of the account page). */
export const DIRECT_MESSAGES = {
  TOO_LARGE: { error: "الحد الأقصى لحجم الملف 20 ميغابايت.", errorEn: "Files are limited to 20 MB." },
  UNSUPPORTED_TYPE: { error: "يُقبل PDF أو JPEG أو PNG فقط؛ يحدده محتوى الملف لا اسمه.", errorEn: "Only PDF, JPEG or PNG — the file's own contents decide, not its name." },
  STORAGE_UNAVAILABLE: {
    error: "تعذّر رفع الملف الآن: مخزن الملفات لا يستجيب. الملفات الأكبر من 4 ميغابايت تُرفع إلى المخزن مباشرة ولا تُحفظ في قاعدة البيانات. أُبلغ مدير النظام؛ أعد المحاولة لاحقًا أو ارفع ملفًا أصغر من 4 ميغابايت.",
    errorEn: "The file cannot be uploaded now: file storage is not responding. Files over 4 MB go straight to storage and are not kept in the database. The administrator has been alerted; try again later or upload a file under 4 MB.",
  },
  NETWORK: {
    error: "انقطع الرفع قبل اكتماله ومخزن الملفات يعمل. تحقق من اتصالك بالإنترنت ثم أعد المحاولة.",
    errorEn: "The upload stopped before it finished, and file storage is working. Check your connection and try again.",
  },
  EXPIRED: { error: "انتهت مهلة هذا الرفع. أعد المحاولة.", errorEn: "This upload has expired. Try again." },
  REJECTED: { error: "رُفض الملف بعد رفعه: محتواه لا يطابق ما يُقبل (PDF أو JPEG أو PNG حتى 20 ميغابايت)، وحُذف من المخزن.", errorEn: "The file was refused after upload: its contents are not an accepted PDF, JPEG or PNG of up to 20 MB, and it was removed from storage." },
} as const;
