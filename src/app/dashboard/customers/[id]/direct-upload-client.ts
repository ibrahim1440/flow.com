// The browser's half of a direct upload (feat/blob-client-upload): prepare → @vercel/blob/client
// uploadPresigned (progress) → finalize; on a failed upload the server is asked what happened
// (…/direct/failed), which raises the storage incident itself when the store is down. The rules and
// messages are shared with the server: services/customers/direct-upload-rules.ts.
import { uploadPresigned } from "@vercel/blob/client";
import { UPLOAD_STALL_MS, classifyUploadError, sniffDirectType, DIRECT_MESSAGES } from "@/lib/services/customers/direct-upload-rules";

type Msg = { error?: string; errorEn?: string; code?: string };
export type DirectResult = { ok: true; id?: string } | { ok: false; message: Msg; retry: boolean };

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Msg & Record<string, unknown> } | null> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return null;
  return { status: r.status, data: ((await r.json().catch(() => null)) ?? {}) as Msg & Record<string, unknown> };
}
const NO_CONNECTION: Msg = { error: "تعذّر الاتصال.", errorEn: "Could not connect." };

export async function directUpload(opts: {
  customerId: string; file: File; category: string; title: string;
  onProgress: (percentage: number) => void; signal?: AbortSignal;
}): Promise<DirectResult> {
  const { customerId, file } = opts;
  const base = `/api/customers/${encodeURIComponent(customerId)}/files/direct`;
  // The type is the bytes' (the server checks them again after the upload).
  const contentType = sniffDirectType(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (!contentType) return { ok: false, message: DIRECT_MESSAGES.UNSUPPORTED_TYPE, retry: false };

  const prep = await postJson(base, { fileName: file.name, size: file.size, contentType, category: opts.category, title: opts.title });
  if (!prep) return { ok: false, message: NO_CONNECTION, retry: true };
  if (prep.status !== 201) return { ok: false, message: prep.data, retry: prep.status >= 500 };
  const { uploadId, pathname, handleUploadUrl } = prep.data as unknown as { uploadId: string; pathname: string; handleUploadUrl: string };

  // The SDK retries a store that is down for many minutes; an upload with no progress for
  // UPLOAD_STALL_MS is given up and reported instead.
  const ctl = new AbortController();
  let stalled = false;
  let last = Date.now();
  const watch = setInterval(() => { if (Date.now() - last > UPLOAD_STALL_MS) { stalled = true; ctl.abort(); } }, 1000);
  const cancel = () => ctl.abort();
  opts.signal?.addEventListener("abort", cancel);
  try {
    await uploadPresigned(pathname, file, {
      access: "private", handleUploadUrl, contentType, abortSignal: ctl.signal,
      onUploadProgress: ({ percentage }) => { last = Date.now(); opts.onProgress(percentage); },
    });
  } catch (e) {
    const reason = classifyUploadError(e instanceof Error ? e.message : String(e), { stalled, cancelled: !!opts.signal?.aborted });
    const r = await postJson(`${base}/failed`, { uploadId, reason });
    // The store has the whole file after all: finalize it.
    if (!(r && r.status === 200 && r.data.uploaded === true)) {
      return { ok: false, message: r ? r.data : NO_CONNECTION, retry: reason !== "TOO_LARGE" && reason !== "TYPE" };
    }
  } finally {
    clearInterval(watch);
    opts.signal?.removeEventListener("abort", cancel);
  }
  opts.onProgress(100);
  const fin = await postJson(`${base}/finalize`, { uploadId });
  if (!fin) return { ok: false, message: NO_CONNECTION, retry: true };
  // The row takes the upload's id (direct-upload.ts): the dates of a contract are set on it next (batch 24 WP-C).
  if (fin.status === 200 || fin.status === 201) return { ok: true, id: uploadId };
  return { ok: false, message: fin.data, retry: fin.status >= 500 || fin.status === 409 };
}
