"use client";
/**
 * Roasting station v2 — the screen's server calls. Reads go straight to the API; the floor's writes (drop, charge,
 * weighing) go through the offline queue with their Idempotency-Key (D12 R11), the rest are sent directly with a key.
 */
import { newRequestKey } from "@/lib/request-key";
import { OfflineQueue, indexedDbStore, type QueuedOp, type SendResult } from "@/lib/station/v2/offline-queue";

export const V2 = "/api/station/roasting/v2";
export type ApiResult<T = Record<string, unknown>> = { ok: boolean; status: number; body: T & { error?: string; errorEn?: string; code?: string } };

/** A read. `poll` marks a background poll (x-station-poll) so it does not keep the station session alive past its idle lock. */
export async function getJson<T>(url: string, opts: { poll?: boolean } = {}): Promise<ApiResult<T>> {
  const r = await fetch(url, { cache: "no-store", headers: opts.poll ? { "x-station-poll": "1" } : {} });
  const body = (await r.json().catch(() => ({}))) as ApiResult<T>["body"];
  return { ok: r.ok, status: r.status, body };
}

export async function postJson<T>(url: string, body: Record<string, unknown>, key: string | null = newRequestKey(), method = "POST"): Promise<ApiResult<T>> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as ApiResult<T>["body"];
  return { ok: r.ok, status: r.status, body: out };
}

async function sendQueued(op: QueuedOp): Promise<SendResult> {
  try {
    const r = await fetch(op.url, { method: op.method, headers: { "Content-Type": "application/json", "Idempotency-Key": op.key }, body: JSON.stringify(op.body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch {
    return { network: true };
  }
}

let queue: OfflineQueue | null = null;
export function floorQueue(): OfflineQueue {
  queue ??= new OfflineQueue(indexedDbStore(), sendQueued);
  return queue;
}

export type QueuedResult<T> = { queued: true; auth?: boolean } | ApiResult<T> | { skipped: true };
export type WriteSpec = { label: string; url: string; body: Record<string, unknown>; roasterId?: string | null; title?: string | null; titleEn?: string | null };

/**
 * Floor writes through the queue, chained in order (each waits for the one before it). Online: sent now and their answers
 * returned; a refusal answered NOW is shown by the caller, so it leaves the queue (with what was chained after it —
 * `skipped`). Offline, or the session lapsed (`auth`): kept with their keys and sent later — `queued: true`.
 */
export async function queuedWrites<T = Record<string, unknown>>(specs: WriteSpec[]): Promise<QueuedResult<T>[]> {
  const q = floorQueue();
  const ops = [];
  let after: string | null = null;
  for (const s of specs) {
    const op = await q.enqueue({ key: newRequestKey(), method: "POST", url: s.url, body: s.body, label: s.label, roasterId: s.roasterId ?? null, title: s.title ?? null, titleEn: s.titleEn ?? null, after });
    after = op.key;
    ops.push(op);
  }
  const rep = await q.flush();
  const out: QueuedResult<T>[] = [];
  let cut = false;
  for (const op of ops) {
    if (cut) { await q.discard(op.id); out.push({ skipped: true }); continue; }
    const done = rep.sent.find((s) => s.op.id === op.id);
    if (done) { out.push({ ok: true, status: done.status, body: (done.body ?? {}) as ApiResult<T>["body"] }); continue; }
    const no = rep.refused.find((s) => s.id === op.id);
    if (no?.refusal) {
      await q.discard(op.id);
      cut = true;
      out.push({ ok: false, status: no.refusal.status, body: (no.refusal.body ?? {}) as ApiResult<T>["body"] });
      continue;
    }
    out.push({ queued: true, ...(rep.authRequired ? { auth: true } : {}) });
  }
  return out;
}

/** One floor write through the queue (see queuedWrites). */
export async function queuedWrite<T>(spec: WriteSpec): Promise<{ queued: true; auth?: boolean } | ApiResult<T>> {
  const [r] = await queuedWrites<T>([spec]);
  return "skipped" in r ? { queued: true } : r;
}
