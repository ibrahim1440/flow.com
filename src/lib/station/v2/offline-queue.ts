/**
 * Roasting station v2 (D12 R11) — the offline queue for the floor's writes (drop, charge, weighing). Each operation keeps
 * the Idempotency-Key it was created with, so a retry can never apply twice (the server answers a replay with what it
 * already did). Operations are sent in order; what the server answers decides what happens to an operation:
 *
 *   2xx                          → done, removed.
 *   network failure              → kept; the run stops (the rest wait, in order).
 *   401 / 403                    → kept; the run stops until the employee signs in again (`authRequired`).
 *   408 / 429 / 5xx / retryable  → kept with a backoff; the run stops (409 RETRY_CONFLICT is retryable).
 *   any other 4xx (a refusal)    → NEVER dropped silently: kept as «refused» with the server's reason, reported, and left
 *                                  for the operator to retry or delete. Operations chained `after` it wait for it.
 *
 * Every operation belongs to the employee who did it (`owner`): the queue sends only the signed-in employee's operations,
 * so nothing ever replays as somebody else.
 *
 * Pure apart from its two ports — the store (IndexedDB in the browser, memory in tests) and `send` — so it is unit-tested.
 */
export type Refusal = { status: number; code: string | null; message: string; messageEn?: string; body: unknown };
export type QueuedOp = {
  id: string; key: string; method: "POST"; url: string; body: Record<string, unknown>; label: string; createdAt: number; attempts: number;
  /** Who did it (employee id) and their name, for the tray. */
  owner?: string | null; ownerName?: string | null;
  /** The roaster column it belongs to, and a human title for the tray («تحميل الدلو 4»). */
  roasterId?: string | null; title?: string | null; titleEn?: string | null;
  /** The key of an operation that must be applied first (the charge of «تفريغ وتحميل» waits for its drop). */
  after?: string | null;
  state?: "pending" | "refused"; refusal?: Refusal | null; nextAt?: number | null;
};
export type QueueStore = { all(): Promise<QueuedOp[]>; put(op: QueuedOp): Promise<void>; remove(id: string): Promise<void> };
export type SendResult = { status: number; body: unknown } | { network: true };
export type FlushReport = {
  sent: { op: QueuedOp; status: number; body: unknown }[];
  refused: QueuedOp[];
  left: number;
  stoppedOnNetwork: boolean;
  /** The server answered «try later» (5xx / 429 / RETRY_CONFLICT): reachable, but the run waits for its backoff. */
  retrying: boolean;
  authRequired: boolean;
};
export type Outcome = "done" | "refused" | "retry" | "auth";

export function memoryStore(seed: QueuedOp[] = []): QueueStore {
  const m = new Map(seed.map((o) => [o.id, o]));
  return {
    async all() { return [...m.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)); },
    async put(op) { m.set(op.id, op); },
    async remove(id) { m.delete(id); },
  };
}

/** What an answer means for a queued operation (see the table above). */
export function classify(status: number, body?: unknown): Outcome {
  if (status >= 200 && status < 300) return "done";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429 || status >= 500 || status < 200) return "retry";
  const b = (body ?? {}) as { code?: unknown; retryable?: unknown };
  if (b.retryable === true || b.code === "RETRY_CONFLICT") return "retry";
  return "refused";
}

/** The writes that hold the idle lock for `employeeId`: theirs (or unowned) and still to send — a refused one does not. */
export const writesHoldingIdle = (ops: QueuedOp[], employeeId: string) => ops.filter((o) => (!o.owner || o.owner === employeeId) && o.state !== "refused").length;

/** Backoff for a retryable answer: 2 s, 4 s, 8 s … capped at a minute. */
export const backoffMs = (attempts: number) => Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts - 1));

function refusalOf(status: number, body: unknown): Refusal {
  const b = (body ?? {}) as { code?: unknown; error?: unknown; errorEn?: unknown };
  return { status, code: typeof b.code === "string" ? b.code : null, message: typeof b.error === "string" ? b.error : typeof b.errorEn === "string" ? b.errorEn : "", messageEn: typeof b.errorEn === "string" ? b.errorEn : undefined, body };
}

export class OfflineQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private owner: string | null | undefined = undefined;
  private ownerName: string | null = null;
  constructor(private store: QueueStore, private send: (op: QueuedOp) => Promise<SendResult>, private now: () => number = () => Date.now()) {}

  /** The signed-in employee: only their operations are sent (`undefined` = unbound, every operation is sent). */
  setOwner(id: string | null | undefined, name: string | null = null) { this.owner = id; this.ownerName = name; }

  async enqueue(op: Omit<QueuedOp, "createdAt" | "attempts" | "id" | "state"> & { id?: string }): Promise<QueuedOp> {
    const full: QueuedOp = { owner: this.owner ?? null, ownerName: this.ownerName, ...op, id: op.id ?? op.key, createdAt: this.now(), attempts: 0, state: "pending" };
    const existing = (await this.store.all()).find((o) => o.key === full.key);
    if (existing) return existing; // the same operation twice is one operation
    await this.store.put(full);
    return full;
  }

  pending(): Promise<QueuedOp[]> { return this.store.all(); }

  /** The operations that still need the signed-in employee: theirs (or unowned), refused or not yet sent. */
  async mine(): Promise<QueuedOp[]> { return (await this.store.all()).filter((o) => this.sendable(o)); }

  /** A refused operation, sent again (with the SAME key) on the next flush. */
  async retry(id: string): Promise<void> {
    const op = (await this.store.all()).find((o) => o.id === id);
    if (op) await this.store.put({ ...op, state: "pending", refusal: null, nextAt: null });
  }

  /** Delete an operation (the operator confirmed it); `withDependents` also deletes what was chained after it. */
  async discard(id: string, opts: { withDependents?: boolean } = {}): Promise<QueuedOp[]> {
    const all = await this.store.all();
    const op = all.find((o) => o.id === id);
    if (!op) return [];
    const gone = [op];
    if (opts.withDependents) {
      const keys = new Set([op.key]);
      for (const o of all) if (o.after && keys.has(o.after)) { keys.add(o.key); gone.push(o); }
    }
    for (const g of gone) await this.store.remove(g.id);
    return gone;
  }

  /** Send what is queued, in order. Flushes run one after another (never two sends of the same operation at once). */
  flush(): Promise<FlushReport> {
    const run = this.tail.then(() => this.run());
    this.tail = run.catch(() => undefined);
    return run;
  }

  private sendable(o: QueuedOp) {
    if (this.owner === undefined || !o.owner) return true;
    return o.owner === this.owner;
  }

  private async run(): Promise<FlushReport> {
    const sent: FlushReport["sent"] = [];
    const refused: QueuedOp[] = [];
    const all = await this.store.all();
    const live = new Set(all.map((o) => o.key));
    const stop = async (extra: Partial<FlushReport>): Promise<FlushReport> => ({ sent, refused, left: (await this.store.all()).length, stoppedOnNetwork: false, retrying: false, authRequired: false, ...extra });
    for (const op of all) {
      if (op.state === "refused") continue;                 // waits for the operator
      if (!this.sendable(op)) continue;                      // another employee's: never sent as this one
      if (op.after && live.has(op.after)) continue;          // its predecessor is not applied yet
      if (op.nextAt && op.nextAt > this.now()) return stop({ retrying: true });
      const r = await this.send(op).catch((): SendResult => ({ network: true }));
      if ("network" in r) {
        await this.store.put({ ...op, attempts: op.attempts + 1 });
        return stop({ stoppedOnNetwork: true });
      }
      const outcome = classify(r.status, r.body);
      if (outcome === "auth") {
        await this.store.put({ ...op, attempts: op.attempts + 1 });
        return stop({ authRequired: true });
      }
      if (outcome === "retry") {
        const attempts = op.attempts + 1;
        await this.store.put({ ...op, attempts, nextAt: this.now() + backoffMs(attempts) });
        return stop({ retrying: true });
      }
      if (outcome === "refused") {
        const kept: QueuedOp = { ...op, attempts: op.attempts + 1, state: "refused", refusal: refusalOf(r.status, r.body), nextAt: null };
        await this.store.put(kept);
        refused.push(kept);
        continue;
      }
      await this.store.remove(op.id);
      live.delete(op.key);
      sent.push({ op, status: r.status, body: r.body });
    }
    return stop({});
  }
}

/** The browser store: one IndexedDB object store per roaster device; falls back to memory when IndexedDB is unavailable. */
export function indexedDbStore(name = "hq-roast-v2-queue"): QueueStore {
  if (typeof indexedDB === "undefined") return memoryStore();
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("ops")) req.result.createObjectStore("ops", { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open();
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction("ops", mode);
      const r = fn(t.objectStore("ops"));
      t.oncomplete = () => { resolve(r ? (r as IDBRequest<T>).result : undefined); db.close(); };
      t.onerror = () => { reject(t.error); db.close(); };
    });
  };
  return {
    async all() { const rows = (await tx<QueuedOp[]>("readonly", (s) => s.getAll())) ?? []; return rows.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)); },
    async put(op) { await tx("readwrite", (s) => { s.put(op); }); },
    async remove(id) { await tx("readwrite", (s) => { s.delete(id); }); },
  };
}
