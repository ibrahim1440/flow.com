// The customer file's documents — the «الملفات» tab of the account page (Figma crm-account
// 179:1312), migrations 20261027120000_customer_file and 20261028100000_credit_hold.
//
// ── Where the bytes live (feat/credit-hold, owner decision) ──
// New uploads go to the PRIVATE Vercel Blob store when one is configured (./file-store.ts), under
// customers/<customerId>/<fileId>-<safe name>, up to 20 MB; the row keeps the pathname, the size and
// the SHA-256, and `content` stays NULL. Without a store (local development, tests) — or when the
// store fails at runtime and the file is at most 5 MB — the bytes go in the row as before. Rows
// written before keep their bytes and keep working. This file and the download route are the only
// readers; the browser never receives a Blob URL or pathname.
//
// A Blob failure is never silent: an upload that falls back, an upload refused (over 5 MB with Blob
// down), a download or a delete that fails each report to services/system/storage-alerts.ts, which
// raises one incident alert (in the app and by e-mail) and «تم إصلاح المشكلة» once Blob works again.
//
// ── What is checked ──
// The type is decided by the bytes, never by the name or the browser's claim — the same three
// signatures as collection evidence (services/sales/evidence.ts, reused, not copied). 5 MB in the
// database, 20 MB in Blob; the database refuses more (CHECK). The filename is made safe for a
// header and a table. Pure apart from hashing and the storage calls, so every rule is asserted
// without a database (tests/sales/unit/customer-file.test.ts, tests/sales/unit/credit-hold.test.ts).

import {
  ALLOWED_EVIDENCE, MAX_EVIDENCE_BYTES, evidenceHeaders, safeFilename, sniffEvidenceType, type EvidenceKind,
} from "../sales/evidence";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { MAX_BLOB_FILE_BYTES, MAX_DB_FILE_BYTES, blobPathnameFor, chooseStorage, errorCode } from "./file-store";
import { reportStorageFailure, reportStorageSuccess } from "../system/storage-alerts";

/** The database's limit (and every file's before Blob). Blob files go to MAX_BLOB_FILE_BYTES. */
export const MAX_CUSTOMER_FILE_BYTES = MAX_EVIDENCE_BYTES;
export { MAX_BLOB_FILE_BYTES, MAX_DB_FILE_BYTES };
export const ALLOWED_CUSTOMER_FILE_TYPES: readonly EvidenceKind[] = ALLOWED_EVIDENCE;
export const CUSTOMER_FILE_CATEGORIES = ["CONTRACT", "REGISTRATION", "TAX", "PRICE_AGREEMENT", "OTHER"] as const;
export type CustomerFileCategory = (typeof CUSTOMER_FILE_CATEGORIES)[number];
/** Per customer: a file, not a file server. */
export const MAX_FILES_PER_CUSTOMER = 50;

type Problem = { status: 400 | 413 | 415; code: string; error: string; errorEn: string };

export type ValidatedCustomerFile = {
  category: CustomerFileCategory;
  title: string;
  fileName: string;
  mimeType: EvidenceKind;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
};

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");

/** 413 TOO_LARGE, naming the limit that applies. */
export function tooLarge(maxBytes: number): Problem {
  const mb = Math.round(maxBytes / 1024 / 1024);
  return { status: 413, code: "TOO_LARGE", error: `الحد الأقصى لحجم الملف ${mb} ميغابايت.`, errorEn: `Files are limited to ${mb} MB.` };
}

/**
 * Check an upload and produce the row, or say why not (Arabic first, as every refusal of the
 * account page). `rawTitle` empty → the filename without its extension.
 */
export function validateCustomerFile(
  bytes: Uint8Array,
  rawFilename: string,
  rawCategory: unknown,
  rawTitle: unknown,
  maxBytes: number = MAX_CUSTOMER_FILE_BYTES,
): { ok: true; value: ValidatedCustomerFile } | { ok: false; problem: Problem } {
  const category = (typeof rawCategory === "string" && rawCategory ? rawCategory : "OTHER") as CustomerFileCategory;
  if (!CUSTOMER_FILE_CATEGORIES.includes(category)) {
    return { ok: false, problem: { status: 400, code: "BAD_CATEGORY", error: "تصنيف الملف غير معروف.", errorEn: "Unknown file category." } };
  }
  if (bytes.length === 0) {
    return { ok: false, problem: { status: 400, code: "EMPTY", error: "الملف فارغ.", errorEn: "That file is empty." } };
  }
  if (bytes.length > maxBytes) return { ok: false, problem: tooLarge(maxBytes) };
  const mimeType = sniffEvidenceType(bytes);
  if (!mimeType) {
    return { ok: false, problem: { status: 415, code: "UNSUPPORTED_TYPE", error: "يُقبل PDF أو JPEG أو PNG فقط؛ يحدده محتوى الملف لا اسمه.", errorEn: "Only PDF, JPEG or PNG — the file's own contents decide, not its name." } };
  }
  const fileName = safeFilename(clean(rawFilename) || "file", mimeType);
  const title = (clean(rawTitle) || fileName.replace(/\.[a-z]+$/, "")).slice(0, 120);
  const content = Buffer.from(bytes);
  return {
    ok: true,
    value: { category, title, fileName, mimeType, sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), content },
  };
}

/**
 * The download headers: attachment, nosniff, no cache, sandboxed (as collection evidence). A
 * customer's documents are often named in Arabic, and a header value must be Latin-1, so the
 * plain `filename` is an ASCII fallback and the real name goes in `filename*` (RFC 6266 / 5987).
 */
export function customerFileHeaders(f: { fileName: string; mimeType: string; sizeBytes: number }): HeadersInit {
  const base = evidenceHeaders({ filename: "file", mimeType: f.mimeType, byteSize: f.sizeBytes }) as Record<string, string>;
  const ext = f.fileName.match(/\.[a-z]+$/)?.[0] ?? "";
  const ascii = f.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  const fallback = /[A-Za-z0-9]/.test(ascii.replace(ext, "")) ? ascii : `file${ext}`;
  return {
    ...base,
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
  };
}

/** The metadata a list shows — never the bytes. */
export const CUSTOMER_FILE_SELECT = {
  id: true, category: true, title: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} as const;

/** Where the bytes of a new upload may go, and up to what size (the route checks it first). */
export function uploadLimit(env: Record<string, string | undefined> = process.env): { storage: "blob" | "db"; maxBytes: number } {
  const c = chooseStorage(env);
  return { storage: c.kind, maxBytes: c.maxBytes };
}

type Db = PrismaClient;
const newFileId = () => `cf${randomBytes(12).toString("hex")}`;

/**
 * Store a checked upload and create its row. Blob when configured; the database otherwise. When
 * Blob fails at runtime: a file of at most 5 MB goes to the database (and the incident counts it);
 * a larger one is refused 503 STORAGE_UNAVAILABLE in Arabic. Never a silent fallback: every
 * failure reaches storage-alerts.
 */
export async function saveCustomerFile(
  db: Db,
  input: { customerId: string; uploadedById: string; file: ValidatedCustomerFile },
): Promise<{ ok: true; row: PrismaNS.CustomerFileGetPayload<{ select: typeof CUSTOMER_FILE_SELECT }>; storage: "blob" | "db"; fallback: boolean } | { ok: false; problem: { status: 413 | 503; code: string; error: string; errorEn: string } }> {
  const v = input.file;
  const choice = chooseStorage();
  const base = {
    customerId: input.customerId, category: v.category, title: v.title, fileName: v.fileName, mimeType: v.mimeType,
    sizeBytes: v.sizeBytes, sha256: v.sha256, uploadedById: input.uploadedById,
  };
  const inRow = () => db.customerFile.create({ data: { ...base, content: new Uint8Array(v.content) }, select: CUSTOMER_FILE_SELECT });

  if (choice.kind === "db") {
    if (v.sizeBytes > MAX_DB_FILE_BYTES) return { ok: false, problem: { ...tooLarge(MAX_DB_FILE_BYTES), status: 413 } };
    // Production with no Blob store connected: saved, and the owner is told what to connect.
    if (choice.productionGap) await reportStorageFailure(db, "NOT_CONFIGURED", null, "FALLBACK");
    return { ok: true, row: await inRow(), storage: "db", fallback: false };
  }

  const id = newFileId();
  const pathname = blobPathnameFor(input.customerId, id, v.fileName);
  try {
    await choice.store.put(pathname, v.content, v.mimeType);
  } catch (e) {
    const code = errorCode(e);
    if (v.sizeBytes <= MAX_DB_FILE_BYTES) {
      await reportStorageFailure(db, "UPLOAD_FAILED", code, "FALLBACK");
      return { ok: true, row: await inRow(), storage: "db", fallback: true };
    }
    await reportStorageFailure(db, "UPLOAD_FAILED", code, "REFUSED");
    return {
      ok: false,
      problem: {
        status: 503, code: "STORAGE_UNAVAILABLE",
        error: "تعذّر حفظ الملف الآن: مخزن الملفات لا يستجيب، والملفات الأكبر من 5 ميغابايت لا تُحفظ في قاعدة البيانات. أُبلغ مدير النظام؛ أعد المحاولة لاحقًا أو ارفع ملفًا أصغر من 5 ميغابايت.",
        errorEn: "The file could not be saved now: file storage is not responding, and files over 5 MB are not kept in the database. The administrator has been alerted; try again later or upload a file under 5 MB.",
      },
    };
  }
  await reportStorageSuccess(db);
  try {
    const row = await db.customerFile.create({ data: { ...base, id, blobPathname: pathname }, select: CUSTOMER_FILE_SELECT });
    return { ok: true, row, storage: "blob", fallback: false };
  } catch (e) {
    // The row did not commit: the blob must not outlive it.
    await choice.store.del([pathname]).catch(() => undefined);
    throw e;
  }
}

/**
 * The bytes of a stored file, as a stream: the row's own bytes, or the private blob streamed
 * through the app. A blob that cannot be read is a clear Arabic 502 (and an incident), never a
 * silent substitute; a blob that is missing is a 404.
 */
export async function openCustomerFile(
  db: Db,
  row: { content: Uint8Array | null; blobPathname: string | null },
): Promise<{ ok: true; body: BodyInit } | { ok: false; status: 404 | 502 | 503; code: string; error: string; errorEn: string }> {
  if (row.content) return { ok: true, body: new Uint8Array(row.content) };
  if (!row.blobPathname) return { ok: false, status: 404, code: "NOT_FOUND", error: "الملف غير موجود.", errorEn: "Not found" };
  const choice = chooseStorage();
  const unavailable = { ok: false as const, status: 502 as const, code: "STORAGE_UNAVAILABLE", error: "تعذّر تنزيل الملف الآن: مخزن الملفات لا يستجيب. الملف لم يُحذف؛ أُبلغ مدير النظام، أعد المحاولة بعد قليل.", errorEn: "The file cannot be downloaded now: file storage is not responding. The file is not lost; the administrator has been alerted — try again shortly." };
  if (choice.kind !== "blob") {
    // A blob row with no store configured (the variables were removed): the owner must reconnect it.
    await reportStorageFailure(db, "NOT_CONFIGURED", null, "NONE");
    return { ...unavailable, status: 503 };
  }
  try {
    const got = await choice.store.get(row.blobPathname);
    await reportStorageSuccess(db);
    if (!got) return { ok: false, status: 404, code: "BLOB_MISSING", error: "محتوى الملف غير موجود في المخزن.", errorEn: "The file's content is missing from storage." };
    return { ok: true, body: got.stream };
  } catch (e) {
    await reportStorageFailure(db, "DOWNLOAD_FAILED", errorCode(e), "NONE");
    return unavailable;
  }
}

/**
 * Remove blobs whose rows are gone (a deleted file, a deleted customer, a reset). Best effort
 * after the database committed: a failure leaves an unreachable private blob and an incident,
 * never a row without its bytes.
 */
export async function deleteCustomerFileBlobs(db: Db, pathnames: (string | null)[]): Promise<void> {
  const list = pathnames.filter((p): p is string => !!p);
  if (list.length === 0) return;
  const choice = chooseStorage();
  if (choice.kind !== "blob") return;
  try {
    for (let i = 0; i < list.length; i += 100) await choice.store.del(list.slice(i, i + 100));
    await reportStorageSuccess(db);
  } catch (e) {
    await reportStorageFailure(db, "DELETE_FAILED", errorCode(e), "NONE");
  }
}
