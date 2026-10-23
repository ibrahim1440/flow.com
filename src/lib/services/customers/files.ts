// The customer file's documents — the «الملفات» tab of the account page (Figma crm-account
// 179:1312), migration 20261027120000_customer_file.
//
// ── Where the bytes live ──
// In Postgres (CustomerFile.content), exactly as collection evidence, finance attachments and HR
// documents already store theirs: the deployment's filesystem is ephemeral and the stack has no
// object store (no Blob/S3 client in package.json, no storage variable in .env.example). This
// file is the only reader and writer of the bytes, so moving to object storage later changes
// this file and that column and nothing else.
//
// ── What is checked ──
// The type is decided by the bytes, never by the name or the browser's claim — the same three
// signatures as collection evidence (services/sales/evidence.ts, reused, not copied). 5 MB per
// file; the database refuses more (CHECK). The filename is made safe for a header and a table.
// Pure apart from hashing, so every rule is asserted without a database
// (tests/sales/unit/customer-file.test.ts).

import {
  ALLOWED_EVIDENCE, MAX_EVIDENCE_BYTES, evidenceHeaders, safeFilename, sniffEvidenceType, type EvidenceKind,
} from "../sales/evidence";
import { createHash } from "node:crypto";

export const MAX_CUSTOMER_FILE_BYTES = MAX_EVIDENCE_BYTES;
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

/**
 * Check an upload and produce the row, or say why not (Arabic first, as every refusal of the
 * account page). `rawTitle` empty → the filename without its extension.
 */
export function validateCustomerFile(
  bytes: Uint8Array,
  rawFilename: string,
  rawCategory: unknown,
  rawTitle: unknown,
): { ok: true; value: ValidatedCustomerFile } | { ok: false; problem: Problem } {
  const category = (typeof rawCategory === "string" && rawCategory ? rawCategory : "OTHER") as CustomerFileCategory;
  if (!CUSTOMER_FILE_CATEGORIES.includes(category)) {
    return { ok: false, problem: { status: 400, code: "BAD_CATEGORY", error: "تصنيف الملف غير معروف.", errorEn: "Unknown file category." } };
  }
  if (bytes.length === 0) {
    return { ok: false, problem: { status: 400, code: "EMPTY", error: "الملف فارغ.", errorEn: "That file is empty." } };
  }
  if (bytes.length > MAX_CUSTOMER_FILE_BYTES) {
    return { ok: false, problem: { status: 413, code: "TOO_LARGE", error: "الحد الأقصى لحجم الملف 5 ميغابايت.", errorEn: "Files are limited to 5 MB." } };
  }
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
