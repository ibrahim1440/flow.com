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
//
// ── Direct uploads (feat/blob-client-upload) ──
// A file over 4 MB goes from the browser straight to the store (./direct-upload.ts). For that the
// store also answers `head` (does the blob exist, how big, what type) and `issueUploadToken` (a
// delegation for ONE pathname, put only — @vercel/blob 2.8.2 `issueSignedToken`, which authenticates
// with OIDC + BLOB_STORE_ID like every other call; no BLOB_READ_WRITE_TOKEN is needed). The browser
// then learns that pathname (its upload slot) — never a URL it could download from: the store is
// private and downloads still stream through the app. The mock directory answers both too, and
// receives the browser's presigned PUT at /api/system/blob-mock (NEXT_PUBLIC_VERCEL_BLOB_API_URL=
// http://<host>/api/system/blob-mock?x= at build time, local builds only), checking the same signature, pathname, size, type and expiry Blob checks.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  /** Direct uploads: the blob's metadata, null when it does not exist (stores without it offer no direct path). */
  head?(pathname: string): Promise<{ size: number; contentType: string; uploadedAt: Date } | null>;
  /** Direct uploads: a delegation scoped to one pathname (see direct-upload-rules.ts directTokenScope). */
  issueUploadToken?(scope: UploadTokenScope): Promise<IssuedUploadToken>;
};

export type UploadTokenScope = {
  pathname: string; operations: ("put")[]; validUntil: number; maximumSizeInBytes: number; allowedContentTypes: string[];
};
/** The shape of @vercel/blob's IssuedSignedToken. */
export type IssuedUploadToken = { delegationToken: string; clientSigningToken: string; validUntil: number };

/** Does this store support the browser's direct upload? */
export function supportsDirectUpload(store: BlobStore): store is BlobStore & Required<Pick<BlobStore, "head" | "issueUploadToken">> {
  return typeof store.head === "function" && typeof store.issueUploadToken === "function";
}

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
    async head(pathname) {
      const { head, BlobNotFoundError } = await sdk();
      try {
        const h = await head(pathname, { abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
        return { size: h.size, contentType: h.contentType, uploadedAt: new Date(h.uploadedAt) };
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },
    async issueUploadToken(scope) {
      // POST /signed-token on the Blob API, authenticated like put/get/del (OIDC first).
      const { issueSignedToken } = await sdk();
      return issueSignedToken({ ...scope, abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
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
    async put(pathname, bytes, contentType) {
      if (failing()) throw boom();
      const f = file(pathname);
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, bytes, { flag: "wx" });
      await writeMockMeta(dir, pathname, contentType);
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
      for (const p of pathnames) {
        await rm(file(p), { force: true });
        await rm(mockMetaFile(dir, p), { force: true });
      }
    },
    async head(pathname) {
      if (failing()) throw boom();
      const f = file(pathname);
      let st;
      try { st = await stat(f); } catch { return null; }
      const meta = await readFile(mockMetaFile(dir, pathname), "utf8").then((t) => JSON.parse(t) as { contentType?: string }).catch(() => ({ contentType: undefined }));
      return { size: st.size, contentType: meta.contentType ?? "application/octet-stream", uploadedAt: st.mtime };
    },
    async issueUploadToken(scope) {
      if (failing()) throw boom();
      return mockIssueToken(dir, scope);
    },
  };
}

// ── The mock directory's stand-in for Blob's presigned uploads (never on Vercel) ──────────────────
// Same token shapes as @vercel/blob 2.8.2 (src/signed-token.ts, presign-query-params.ts): a
// delegation `<base64url JSON>.<HMAC>` and a client signing key HMAC(secret, delegation) that the
// SDK's presign() uses to sign the canonical `operation=put / pathname=… / vercel-blob-…` lines. The
// secret is random per directory (.mock-secret), so only this app's own tokens verify.

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const mockMetaFile = (dir: string, pathname: string) => {
  const root = path.resolve(dir, ".meta");
  const f = path.resolve(root, `${pathname}.json`);
  if (!f.startsWith(root + path.sep)) throw new Error("bad pathname");
  return f;
};
async function writeMockMeta(dir: string, pathname: string, contentType: string) {
  const f = mockMetaFile(dir, pathname);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify({ contentType }));
}
function mockSecret(dir: string): string {
  const f = path.join(dir, ".mock-secret");
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true });
    try { writeFileSync(f, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); } catch { /* another request wrote it */ }
  }
  return readFileSync(f, "utf8").trim();
}
function mockIssueToken(dir: string, scope: UploadTokenScope): IssuedUploadToken {
  const secret = mockSecret(dir);
  const payload = b64url(Buffer.from(JSON.stringify({ storeId: "store_mockdir", ...scope })));
  const delegationToken = `${payload}.${b64url(createHmac("sha256", secret).update(payload).digest())}`;
  const clientSigningToken = b64url(createHmac("sha256", secret).update(delegationToken).digest());
  return { delegationToken, clientSigningToken, validUntil: scope.validUntil };
}
const CANONICAL_KEYS = [
  "vercel-blob-add-random-suffix", "vercel-blob-allow-overwrite", "vercel-blob-allowed-content-types",
  "vercel-blob-cache-control-max-age", "vercel-blob-callback-token-payload", "vercel-blob-callback-url",
  "vercel-blob-if-match", "vercel-blob-maximum-size-in-bytes", "vercel-blob-valid-until",
];
const blobApiError = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

/**
 * The browser's presigned PUT, as the Blob API would take it: the signature, the delegation's
 * pathname, its expiry, the size and type limits, private access and no overwrite. Returns the
 * response the SDK expects (or the error shape its getBlobError maps). Mock directory only.
 */
export async function mockReceivePresignedPut(
  env: Record<string, string | undefined>,
  url: URL,
  headers: Headers,
  body: Uint8Array,
): Promise<{ status: number; body: unknown }> {
  const dir = env.CUSTOMER_FILES_BLOB_MOCK_DIR?.trim();
  if (!dir || env.VERCEL === "1") return blobApiError(404, "not_found", "Not found");
  if (existsSync(path.join(dir, ".fail"))) return blobApiError(503, "service_unavailable", "mock blob unavailable");
  const q = url.searchParams;
  // The SDK appends "/?pathname=…" to the API URL; a path ending in "/" would be redirected by Next
  // (and a redirected PUT loses its body), so the mock's API URL ends in "?x=" and the SDK's own
  // query arrives inside `x`.
  const pathname = q.get("pathname") ?? new URLSearchParams((q.get("x") ?? "").replace(/^\/\?/, "")).get("pathname") ?? "";
  const delegation = q.get("vercel-blob-delegation") ?? "";
  const signature = q.get("vercel-blob-signature") ?? "";
  const secret = mockSecret(dir);
  const dot = delegation.indexOf(".");
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (dot < 0 || !eq(delegation.slice(dot + 1), b64url(createHmac("sha256", secret).update(delegation.slice(0, dot)).digest()))) {
    return blobApiError(403, "forbidden", "Invalid delegation");
  }
  const scope = JSON.parse(fromB64url(delegation.slice(0, dot)).toString("utf8")) as UploadTokenScope;
  const lines = [`operation=put`, `pathname=${pathname}`];
  for (const k of CANONICAL_KEYS) { const v = q.get(k); if (v) lines.push(`${k}=${v}`); }
  lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const clientKey = b64url(createHmac("sha256", secret).update(delegation).digest());
  if (!eq(signature, b64url(createHmac("sha256", clientKey).update(lines.join("\n")).digest()))) return blobApiError(403, "forbidden", "Invalid signature");
  if (!scope.operations?.includes("put")) return blobApiError(403, "forbidden", "Operation not allowed");
  if (scope.pathname !== pathname) return blobApiError(400, "bad_request", `The "pathname" ${pathname} does not match the token payload`);
  const until = Math.min(scope.validUntil, Number(q.get("vercel-blob-valid-until") ?? Infinity));
  if (Date.now() > until) return blobApiError(403, "forbidden", "Token expired");
  if (headers.get("x-vercel-blob-access") !== "private") return blobApiError(400, "bad_request", "access must be private");
  const max = Math.min(scope.maximumSizeInBytes, Number(q.get("vercel-blob-maximum-size-in-bytes") ?? Infinity));
  if (body.length > max) return blobApiError(400, "bad_request", `File is too large: the file length cannot be greater than ${max} bytes`);
  const contentType = headers.get("x-content-type") ?? "application/octet-stream";
  const allowed = (q.get("vercel-blob-allowed-content-types") ?? scope.allowedContentTypes.join(",")).split(",");
  if (!allowed.includes(contentType) || !scope.allowedContentTypes.includes(contentType)) return blobApiError(400, "bad_request", `contentType ${contentType} is not allowed`);
  const f = path.resolve(dir, pathname);
  if (!f.startsWith(path.resolve(dir) + path.sep)) return blobApiError(400, "bad_request", "bad pathname");
  if (existsSync(f)) return blobApiError(400, "bad_request", "This blob already exists, use `allowOverwrite: true` if you want to overwrite it.");
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, body, { flag: "wx" });
  await writeMockMeta(dir, pathname, contentType);
  const blobUrl = `https://mockdir.private.blob.vercel-storage.com/${pathname}`;
  return { status: 200, body: { url: blobUrl, downloadUrl: `${blobUrl}?download=1`, pathname, contentType, contentDisposition: "attachment", etag: `"${b64url(createHmac("sha256", "etag").update(body).digest()).slice(0, 16)}"` } };
}
