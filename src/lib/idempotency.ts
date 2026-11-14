// R1-b (owner decisions 1-أ / 1-ب / 1-ج): a money or stock write happens ONCE per request, whatever the network and the
// fingers do — a double click, a retry after a lost response, eight simultaneous submits of the same form.
//
// The caller sends an Idempotency-Key (the screens make one per submission with createRequestKeyHolder, lib/request-key.ts)
// and the write runs through withIdempotency(scope):
//   · the key row is INSERTed FIRST, inside the write's own transaction. A concurrent duplicate blocks on the UNIQUE
//     (actor, scope, key) until the first transaction ends: committed → it finds the row and replays the stored answer
//     (200, `replayed: true`); rolled back → it proceeds as the first;
//   · a write that fails (an error, or a non-2xx answer) rolls its key row back with it — the same key may be retried;
//   · the same key for a DIFFERENT request (another intent hash) is refused: 409 REQUEST_KEY_REUSED;
//   · no key on a point where it is required: 400 IDEMPOTENCY_KEY_REQUIRED (every caller in this repository sends one).
// The key is scoped by actor: one person's key never answers for another person.
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { NextResponse } from "@/lib/api-response";

type Tx = Prisma.TransactionClient;
export type IdemAnswer = { status: number; body: unknown };

const HEADER = "idempotency-key";
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SCOPE_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/** The request's Idempotency-Key: null when absent, `false` when malformed. */
export function idempotencyKeyOf(request: Request): string | null | false {
  const raw = request.headers.get(HEADER);
  if (raw === null || raw.trim() === "") return null;
  const key = raw.trim();
  return KEY_PATTERN.test(key) ? key : false;
}

/** A stable hash of what the request asks for (JSON with sorted object keys). */
export function intentHash(intent: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v === undefined ? null : v;
  };
  return createHash("sha256").update(JSON.stringify(norm(intent))).digest("hex");
}

/** Carries a non-2xx answer out of the transaction, so the key row rolls back with the write. */
class NotStored { constructor(readonly answer: IdemAnswer) {} }

const json = (a: IdemAnswer) => NextResponse.json(a.body as Record<string, unknown>, { status: a.status });

/**
 * The outcome of a protected write: `done` is the answer to send as it is (a replay, a refusal, a non-2xx answer); `fresh`
 * is the first time — the write committed with its key, and the route may still do its after-commit work (a deal link, the
 * preparation), then `finalize` the answer a later replay gets.
 */
export type IdemOutcome =
  | { done: Response }
  | { fresh: IdemAnswer; finalize: (answer: IdemAnswer) => Promise<void> };

const KEY_INVALID = () => NextResponse.json({ error: "مفتاح التكرار يقبل الحروف اللاتينية والأرقام و . _ : - فقط (حتى 200 حرف).", errorEn: "The Idempotency-Key may contain only letters, digits and . _ : - (at most 200 characters).", code: "IDEMPOTENCY_KEY_INVALID" }, { status: 400 });
const KEY_REQUIRED = () => NextResponse.json({ error: "مفتاح التكرار مطلوب لهذه العملية.", errorEn: "An Idempotency-Key is required for this request.", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
const KEY_REUSED = () => NextResponse.json({ error: "مفتاح التكرار هذا استُخدم لطلب مختلف. أعد المحاولة من الشاشة.", errorEn: "This Idempotency-Key was already used for a different request.", code: "REQUEST_KEY_REUSED" }, { status: 409 });
/**
 * R1-b gate M1: the same key is being written by another request at this moment. Answering at once (425, the screen
 * retries the same key after Retry-After and gets the first answer replayed) instead of waiting on the unique index —
 * which held a pooled connection per waiting duplicate: a first burst of 20 duplicates exhausted the pool (500 × 10).
 * 425 is an ambiguous status for the screens (lib/request-key.ts): the key is kept, never retired.
 */
const IN_PROGRESS = () => NextResponse.json(
  { error: "الطلب قيد المعالجة — لحظة ونعيد المحاولة تلقائيًا.", errorEn: "This request is already being processed. Retry shortly with the same key.", code: "IDEMPOTENCY_IN_PROGRESS" },
  { status: 425, headers: { "Retry-After": "1" } },
);
class InProgress extends Error {}
const stored = (body: unknown) => JSON.parse(JSON.stringify(body ?? null)) as Prisma.InputJsonValue;
const noop = async () => undefined;

/**
 * Run `write` once per (actor, scope, Idempotency-Key). `write` receives the transaction to do ALL its writes in (pass it
 * to the service's `tx` parameter) and returns the answer. Errors thrown by `write` propagate unchanged (the route maps
 * them as before) — and roll the key row back.
 */
export async function runIdempotent(
  request: Request,
  opts: { scope: string; actorId: string; intent: unknown; required?: boolean },
  write: (tx: Tx) => Promise<IdemAnswer>,
): Promise<IdemOutcome> {
  if (!SCOPE_PATTERN.test(opts.scope)) throw new Error(`withIdempotency: bad scope ${opts.scope}`);
  const key = idempotencyKeyOf(request);
  if (key === false) return { done: KEY_INVALID() };
  if (key === null) {
    if (opts.required !== false) return { done: KEY_REQUIRED() };
    try {
      const a = await prisma.$transaction(async (tx) => {
        const answer = await write(tx);
        if (answer.status < 200 || answer.status > 299) throw new NotStored(answer);
        return answer;
      }, TX_OPTS);
      return { fresh: a, finalize: noop };
    } catch (err) {
      if (err instanceof NotStored) return { done: json(err.answer) };
      throw err;
    }
  }
  const hash = intentHash(opts.intent);
  try {
    type Out = { kind: "reused" } | { kind: "replay"; replay: IdemAnswer } | { kind: "fresh"; fresh: IdemAnswer; id: string };
    const out: Out = await prisma.$transaction(async (tx): Promise<Out> => {
      // M1: one holder per (actor, scope, key) at a time, taken WITHOUT waiting. A duplicate that finds it held returns
      // 425 at once and frees its connection; once the holder has committed (or rolled back) the lock is gone and the
      // next attempt either replays the stored answer or, after a rollback, writes. Every keyed write passes here, so no
      // insert below can wait on another transaction's uncommitted key row.
      const [{ got }] = await tx.$queryRaw<{ got: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`idem:${opts.actorId}|${opts.scope}`}), hashtext(${key})) AS got`;
      if (!got) throw new InProgress();
      const mine = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "IdempotencyRequest" ("id", "actorId", "scope", "key", "intentHash")
        VALUES (${randomUUID()}, ${opts.actorId}, ${opts.scope}, ${key}, ${hash})
        ON CONFLICT ("actorId", "scope", "key") DO NOTHING
        RETURNING "id"`;
      if (mine.length === 0) {
        const seen = await tx.idempotencyRequest.findUniqueOrThrow({ where: { actorId_scope_key: { actorId: opts.actorId, scope: opts.scope, key } } });
        if (seen.intentHash !== hash) return { kind: "reused" };
        return { kind: "replay", replay: { status: seen.responseStatus ?? 200, body: seen.responseBody } };
      }
      const answer = await write(tx);
      if (answer.status < 200 || answer.status > 299) throw new NotStored(answer);
      await tx.idempotencyRequest.update({ where: { id: mine[0].id }, data: { responseStatus: answer.status, responseBody: stored(answer.body), completedAt: new Date() } });
      return { kind: "fresh", fresh: answer, id: mine[0].id };
    }, TX_OPTS);
    if (out.kind === "reused") return { done: KEY_REUSED() };
    if (out.kind === "replay") {
      const body = out.replay.body;
      const replayed = body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>), replayed: true } : body;
      return { done: NextResponse.json(replayed as Record<string, unknown>, { status: 200, headers: { "Idempotent-Replayed": "true" } }) };
    }
    const rowId = out.id;
    return {
      fresh: out.fresh,
      // The answer after the route's after-commit work (best effort: a replay then gets the final answer; if this update is
      // lost, it gets the answer the write committed with).
      finalize: async (answer) => {
        if (answer.status < 200 || answer.status > 299) return;
        await prisma.idempotencyRequest.update({ where: { id: rowId }, data: { responseStatus: answer.status, responseBody: stored(answer.body) } }).catch(() => undefined);
      },
    };
  } catch (err) {
    if (err instanceof NotStored) return { done: json(err.answer) };
    if (err instanceof InProgress) return { done: IN_PROGRESS() };
    throw err;
  }
}

/** runIdempotent for a write with no after-commit work: the answer, or the replay / refusal. */
export async function withIdempotency(
  request: Request,
  opts: { scope: string; actorId: string; intent: unknown; required?: boolean },
  write: (tx: Tx) => Promise<IdemAnswer>,
): Promise<Response> {
  const o = await runIdempotent(request, opts, write);
  return "done" in o ? o.done : json(o.fresh);
}

/**
 * R1-b (owner 1-ج): a write that is ALREADY idempotent by its own key column (requestKey, idempotencyKey, …) reads the key
 * first and inserts when it finds nothing. Two simultaneous requests both find nothing; the slower one's insert then hits
 * the unique key (P2002) — and used to answer 409. Here that one case runs the write once more: the winner's row is now
 * committed, the write finds it and answers with the original (its own replay path). Any other error is unchanged.
 * `needles`: the key's column names or unique-index names.
 */
export function isUniqueConflictOn(err: unknown, needles: string[]): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: Record<string, unknown>; message?: string };
  if (e.code !== "P2002") return false;
  const parts: string[] = [];
  const target = e.meta?.target;
  if (Array.isArray(target)) parts.push(...target.map(String)); else if (target) parts.push(String(target));
  // Prisma 7 with the pg driver adapter carries the constraint under meta.driverAdapterError.cause.
  const cause = (e.meta?.driverAdapterError as { cause?: { constraint?: { fields?: unknown[]; index?: string } } } | undefined)?.cause?.constraint;
  if (cause?.fields) parts.push(...cause.fields.map(String));
  if (cause?.index) parts.push(cause.index);
  parts.push(e.message ?? "");
  const hay = parts.join(" ");
  return needles.some((n) => hay.includes(n));
}

export async function replayOnKeyRace<T>(write: () => Promise<T>, needles: string[]): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueConflictOn(err, needles)) return write();
    throw err;
  }
}

/** R1-b gate L1: how long a stored answer is kept — a retry of the same submission comes within minutes, never a week. */
export const IDEMPOTENCY_KEY_TTL_DAYS = 7;

/**
 * Remove the stored answers created more than `keepDays` days ago; returns how many. The runtime role holds no DELETE on
 * "IdempotencyRequest" (verifier checks 16 / 103), so this goes through idempotency_purge() (20261231170000, SECURITY
 * DEFINER, at least one day kept). R1-d's scheduled job calls it.
 */
export async function purgeExpiredIdempotencyKeys(keepDays = IDEMPOTENCY_KEY_TTL_DAYS): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT idempotency_purge(${Math.trunc(keepDays)}::int) AS n`;
  return Number(rows[0]?.n ?? 0);
}
