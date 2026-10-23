// Where a customer file's bytes go — the storage adapter (feat/credit-hold, owner decision: a
// PRIVATE Vercel Blob store).
//
// ── Choice (read from the environment on every call; nothing cached) ──
//   CUSTOMER_FILES_STORAGE=db           → the database, whatever else is set (an operator's switch);
//   CUSTOMER_FILES_BLOB_MOCK_DIR=<dir>  → a local directory standing in for Blob (tests, local
//                                         previews). Refused on Vercel (VERCEL=1);
//   BLOB_STORE_ID (+ the runtime's Vercel OIDC token) or BLOB_READ_WRITE_TOKEN
//                                       → the private Vercel Blob store (@vercel/blob 2.8.2 resolves
//                                         the credentials itself: OIDC `VERCEL_OIDC_TOKEN` +
//                                         `BLOB_STORE_ID` first, then `BLOB_READ_WRITE_TOKEN`);
//   none of these                       → the database (local development and tests), as before.
//                                         On a Vercel production deployment that is an incident
//                                         (NOT_CONFIGURED): files still save, up to 5 MB.
// Limits: 20 MB in Blob, 5 MB in the database (the migration's CHECKs agree).
//
// The browser never sees a Blob URL or pathname: uploads arrive through the app's route, and
// downloads are streamed by GET /api/customers/[id]/files/[fileId].

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const MAX_DB_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_BLOB_FILE_BYTES = 20 * 1024 * 1024;
/** One Blob call may take this long before it counts as failed (and falls back). */
export const BLOB_TIMEOUT_MS = 20_000;

export type BlobStore = {
  name: "vercel-blob" | "mock-dir" | "test";
  put(pathname: string, bytes: Buffer, contentType: string): Promise<void>;
  /** null when the blob does not exist. */
  get(pathname: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null } | null>;
  del(pathnames: string[]): Promise<void>;
};

export type StorageChoice =
  | { kind: "blob"; store: BlobStore; maxBytes: number }
  | { kind: "db"; maxBytes: number; reason: "SWITCH" | "NOT_CONFIGURED"; productionGap: boolean };

/** A Vercel production deployment with no Blob store connected (the owner must act). */
export const isVercelProduction = (env: Record<string, string | undefined>) => env.VERCEL === "1" && env.VERCEL_ENV === "production";

let injected: BlobStore | null | undefined;
/** Unit tests inject a mock store (null forces the database; undefined restores the environment). */
export function setBlobStoreForTests(s: BlobStore | null | undefined) { injected = s; }

export function chooseStorage(env: Record<string, string | undefined> = process.env): StorageChoice {
  if (injected !== undefined) {
    return injected ? { kind: "blob", store: injected, maxBytes: MAX_BLOB_FILE_BYTES } : { kind: "db", maxBytes: MAX_DB_FILE_BYTES, reason: "SWITCH", productionGap: false };
  }
  if (env.CUSTOMER_FILES_STORAGE === "db") return { kind: "db", maxBytes: MAX_DB_FILE_BYTES, reason: "SWITCH", productionGap: false };
  const mockDir = env.CUSTOMER_FILES_BLOB_MOCK_DIR?.trim();
  if (mockDir && env.VERCEL !== "1") return { kind: "blob", store: mockDirStore(mockDir), maxBytes: MAX_BLOB_FILE_BYTES };
  if (env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim()) return { kind: "blob", store: vercelBlobStore(), maxBytes: MAX_BLOB_FILE_BYTES };
  return { kind: "db", maxBytes: MAX_DB_FILE_BYTES, reason: "NOT_CONFIGURED", productionGap: isVercelProduction(env) };
}

/** customers/<customerId>/<fileId>-<safe name>: ASCII only (Blob pathnames are URLs). */
export function blobPathnameFor(customerId: string, fileId: string, fileName: string): string {
  const ext = fileName.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? "";
  const stem = fileName.slice(0, fileName.length - ext.length).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80);
  const seg = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `customers/${seg(customerId)}/${seg(fileId)}-${stem || "file"}${ext}`;
}

/** The error's name / code for the incident record — never its message (it may carry a URL). */
export function errorCode(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { name?: unknown; code?: unknown; constructor?: { name?: string } };
    const name = typeof o.name === "string" ? o.name : o.constructor?.name ?? "Error";
    const code = typeof o.code === "string" ? `:${o.code}` : "";
    return `${name}${code}`.slice(0, 120);
  }
  return "Error";
}
/** Did Blob refuse our credentials (the owner must act) rather than fail for a moment? */
export function looksLikeAuth(code: string): boolean {
  return /(Access|Auth|Token|Oidc|Store|Forbidden|Unauthori|NotAllowed|Credential)/i.test(code);
}

function vercelBlobStore(): BlobStore {
  // Loaded on use, so a database-only deployment never initialises the SDK.
  const sdk = () => import("@vercel/blob");
  return {
    name: "vercel-blob",
    async put(pathname, bytes, contentType) {
      const { put } = await sdk();
      await put(pathname, bytes, {
        access: "private", contentType, addRandomSuffix: false, allowOverwrite: false,
        abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
      });
    },
    async get(pathname) {
      const { get } = await sdk();
      const r = await get(pathname, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return { stream: r.stream, size: r.blob.size ?? null };
    },
    async del(pathnames) {
      if (pathnames.length === 0) return;
      const { del } = await sdk();
      await del(pathnames, { abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
    },
  };
}

/**
 * A directory standing in for the Blob store (never on Vercel). A file named `.fail` in it makes
 * every call fail — how the HTTP suite drives an incident and its recovery.
 */
function mockDirStore(dir: string): BlobStore {
  const file = (p: string) => {
    const f = path.resolve(dir, p);
    if (!f.startsWith(path.resolve(dir) + path.sep)) throw new Error("bad pathname");
    return f;
  };
  const failing = () => existsSync(path.join(dir, ".fail"));
  const boom = () => Object.assign(new Error("mock blob unavailable"), { name: "BlobServiceNotAvailable" });
  return {
    name: "mock-dir",
    async put(pathname, bytes) {
      if (failing()) throw boom();
      const f = file(pathname);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, bytes, { flag: "wx" });
    },
    async get(pathname) {
      if (failing()) throw boom();
      const f = file(pathname);
      try { await stat(f); } catch { return null; }
      const bytes = await readFile(f);
      return { stream: new Blob([new Uint8Array(bytes)]).stream(), size: bytes.length };
    },
    async del(pathnames) {
      if (failing()) throw boom();
      for (const p of pathnames) await rm(file(p), { force: true });
    },
  };
}
