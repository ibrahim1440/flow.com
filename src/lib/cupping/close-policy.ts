/**
 * E6 — the cupping close policy (owner decisions C-1…C-5, 16 Oct 2026).
 *
 *  • Every cupping session is formal (C-4). Routine single-person checks live in QC.
 *  • A normal (COMPLETE) close needs at least `minScorers` COMPLETE STAFF SCORERS: distinct
 *    authenticated staff (`CuppingScore.employeeId`, C-3) who have submitted an evaluation
 *    of EVERY required cup of the session (owner decision 3, 16 Oct 2026). Required cups: every
 *    CuppingSessionBatch of a multi-cup session; the one cup-less evaluation of a single-cup
 *    session. A partial scorer's evaluations are kept but do not count. Guest evaluations are
 *    supplementary only and never count (C-3, owner decision 4).
 *  • Below the minimum an administrator may close the session as INCOMPLETE with a written
 *    reason (C-2). All scores are kept.
 *  • `minScorers` is administrator-configured, 2–20, default 2 (C-5); the value that applied
 *    is captured on the session when it closes.
 *
 * Counts and per-scorer progress (who has scored how many cups) leave this module — never a
 * score — so the blind rule of an open session holds.
 *
 * The same definition is enforced by the database at close time (`cupping_complete_scorers`
 * in migration 20261016120000_cupping_close_policy): a recorded `scorersAtClose` must equal it.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export const MIN_SCORERS_FLOOR = 2;
export const MIN_SCORERS_CEILING = 20;
export const MIN_SCORERS_DEFAULT = 2;
export const CLOSE_REASON_MAX = 1000;

export type CloseKind = "COMPLETE" | "INCOMPLETE";

type Db = Prisma.TransactionClient | typeof prisma;

/** The settings row; created with the default on first read if the migration's row is gone. */
export async function getCuppingSettings(db: Db = prisma) {
  return db.cuppingSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", minScorers: MIN_SCORERS_DEFAULT },
    update: {},
  });
}

export function isValidMinScorers(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_SCORERS_FLOOR && v <= MIN_SCORERS_CEILING;
}

/**
 * Characters that show nothing: every format character (\p{Cf}: U+200B, U+200E/F, U+FEFF,
 * bidi controls…), every Default_Ignorable_Code_Point (variation selectors, U+034F, Mongolian
 * selectors, the Hangul fillers…), and the blank-looking U+3164, U+115F, U+1160, U+FFA0 and
 * U+2800 named explicitly. (Look-alike letters from other scripts are out of scope.)
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800]/gu;
/** Whitespace, including U+0085 (NEL), which \s does not cover. */
const SPACES = /[\s\u0085]+/gu;

/**
 * A guest name as stored: Unicode NFKC, every invisible character removed, all whitespace runs
 * collapsed to one space, trimmed. «Sara», «Sara\u200B», «Sara\u3164» and «Ｓａｒａ» become the
 * same «Sara».
 */
export function normalizeGuestName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").replace(INVISIBLE, "").replace(SPACES, " ").trim();
}
/** One guest identity per session: the normalized name, case-folded. Used for the duplicate check and the lock key. */
export const guestKey = (name: string) => normalizeGuestName(name).toLowerCase().normalize("NFKC");

/**
 * True when the text has at least one visible character — not only whitespace and invisible
 * characters. The same rule as `cupping_has_visible_text` in the database, which strips a
 * subset of these, so whatever passes here passes there.
 */
export function hasVisibleText(raw: unknown): raw is string {
  return typeof raw === "string" && raw.normalize("NFKC").replace(INVISIBLE, "").replace(SPACES, "") !== "";
}

/** The reason as stored: invisible characters and whitespace removed from both ends. */
export function cleanReason(raw: string): string {
  return raw.replace(/^[\p{Cf}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800\s\u0085]+|[\p{Cf}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800\s\u0085]+$/gu, "");
}

export type ScorerProgress = { employeeId: string; name: string | null; cupsScored: number; complete: boolean };
export type ScorerCounts = {
  /** Complete staff scorers — the figure the minimum is compared with. */
  staffScorers: number;
  /** Staff who scored some but not every required cup (kept, not counted). */
  partialScorers: number;
  /** Distinct guest names (shown, never counted). */
  guestScorers: number;
  /** Cups each scorer must evaluate: the session's cups, or 1 for a single-cup session. */
  requiredCups: number;
  progress: ScorerProgress[];
};

/**
 * Per session: complete and partial staff scorers, guests, and each staff scorer's progress.
 * A multi-cup session's evaluation counts for a cup only when it names one of the session's
 * cups; a single-cup session's evaluation is the cup-less one.
 */
export async function scorerCounts(sessionIds: string[], db: Db = prisma): Promise<Map<string, ScorerCounts>> {
  const out = new Map<string, ScorerCounts>();
  if (sessionIds.length === 0) return out;
  const cups = await db.cuppingSessionBatch.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true, sessionId: true } });
  const cupsOf = new Map<string, Set<string>>();
  for (const id of sessionIds) cupsOf.set(id, new Set());
  for (const c of cups) cupsOf.get(c.sessionId)!.add(c.id);

  const staffRows = await db.cuppingScore.groupBy({
    by: ["sessionId", "employeeId", "sessionBatchId"],
    where: { sessionId: { in: sessionIds }, employeeId: { not: null } },
  });
  const names = new Map<string, string>();
  const ids = [...new Set(staffRows.map((r) => r.employeeId!))];
  if (ids.length) for (const e of await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) names.set(e.id, e.name);

  const scored = new Map<string, Map<string, Set<string>>>(); // session → employee → cups
  for (const r of staffRows) {
    const bySession = scored.get(r.sessionId) ?? new Map<string, Set<string>>();
    scored.set(r.sessionId, bySession);
    const set = bySession.get(r.employeeId!) ?? new Set<string>();
    bySession.set(r.employeeId!, set);
    const sessionCups = cupsOf.get(r.sessionId)!;
    if (sessionCups.size === 0 ? r.sessionBatchId === null : r.sessionBatchId !== null && sessionCups.has(r.sessionBatchId)) {
      set.add(r.sessionBatchId ?? "single");
    }
  }

  const guests = await db.cuppingScore.groupBy({
    by: ["sessionId", "externalName"],
    where: { sessionId: { in: sessionIds }, employeeId: null, externalName: { not: null } },
  });
  const guestKeys = new Map<string, Set<string>>();
  for (const g of guests) {
    if (!g.externalName) continue;
    const set = guestKeys.get(g.sessionId) ?? new Set<string>();
    guestKeys.set(g.sessionId, set);
    set.add(guestKey(g.externalName));
  }

  for (const id of sessionIds) {
    const requiredCups = Math.max(cupsOf.get(id)!.size, 1);
    const progress: ScorerProgress[] = [...(scored.get(id) ?? new Map<string, Set<string>>()).entries()]
      .map(([employeeId, set]) => ({ employeeId, name: names.get(employeeId) ?? null, cupsScored: set.size, complete: set.size >= requiredCups }))
      .sort((x, y) => Number(y.complete) - Number(x.complete) || (x.name ?? "").localeCompare(y.name ?? ""));
    const complete = progress.filter((p) => p.complete).length;
    out.set(id, {
      staffScorers: complete,
      partialScorers: progress.length - complete,
      guestScorers: guestKeys.get(id)?.size ?? 0,
      requiredCups,
      progress,
    });
  }
  return out;
}

/**
 * The policy figures a session carries in the list and detail APIs. Open: the current
 * setting applies. Closed under the policy: the snapshot taken at close. Closed before the
 * policy existed: no minimum is claimed (null) and closeKind stays null.
 */
export function policyView(
  s: { status: string; minScorersAtClose: number | null; scorersAtClose: number | null },
  counts: ScorerCounts | undefined,
  currentMin: number,
) {
  return {
    staffScorers: counts?.staffScorers ?? 0,
    partialScorers: counts?.partialScorers ?? 0,
    guestScorers: counts?.guestScorers ?? 0,
    requiredCups: counts?.requiredCups ?? 1,
    minScorers: s.status === "Open" ? currentMin : s.minScorersAtClose,
  };
}

/**
 * Takes a share lock on an OPEN session row inside a transaction, so a score cannot be
 * written while a concurrent close is deciding on the count (the close takes FOR UPDATE).
 * Returns false when the session is missing or no longer open.
 */
export async function lockOpenSessionForScore(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status" FROM "CuppingSession" WHERE "id" = ${sessionId} FOR SHARE`;
  return rows.length === 1 && rows[0].status === "Open";
}

/** A refusal with a stable machine-readable code, raised inside a transaction. */
export class CuppingRefusal extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
