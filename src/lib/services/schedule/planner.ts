// Roasting schedule «جدول التحميص» — the pure rules (Figma 377:2 RM6–RM8; ROASTERS.md §4–§5).
//
// Nothing here reads or writes the database. The routes (src/app/api/production/schedule/**) read
// the facts, call these functions, and write slots only after the same functions have accepted
// them inside one transaction.
//
//   §5.1  planQuantities   remaining roasted kg → green kg at the product's expected loss, minus the
//                          green of running slots (not recorded yet) and of approved planned slots —
//                          each kilogram counted once.
//   §5.2  splitGreen       feasible batch counts, target first, redistribution only when the last
//                          batch would fall below the minimum, the alternative («البديل»), cents.
//   §5.3  blocked          no compliant distribution → the reason, with the numbers.
//   §5.4  placeSlots       inside working hours, back to back at the cycle, around maintenance,
//                          the roaster's other live slots and the operator's live slots anywhere.
//   §5.5/6 findConflicts   machine overlap and operator overlap across roasters; back-to-back and
//                          cancelled / recorded / missed slots never conflict.
//   §4    effectiveStatus  MISSED is derived on read — never stored, so no job is needed.
//
// Time: every instant is UTC; days, working hours and «today» are Asia/Riyadh. Saudi Arabia keeps
// UTC+3 all year (no daylight saving), so a fixed offset is exact.

export const RIYADH_OFFSET_MS = 3 * 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;

// ── Weights in cents (0.01 kg) ─────────────────────────────────────────────────────────────

/** kg → whole cents (0.01 kg), rounded half up; float noise removed first. */
export function cents(kg: number): number {
  return Math.round(Math.round(kg * 100_000) / 1000);
}
export const kgOf = (c: number) => c / 100;
/** «5.05» */
export const kg2 = (kg: number) => (Math.round(kg * 100) / 100).toFixed(2);
export const round2 = (kg: number) => cents(kg) / 100;

// ── §5.1 quantities ─────────────────────────────────────────────────────────────────────────

export type Quantities = {
  /** Roasted kg still to roast (the roast queue's demand: open − shelf − recorded pipeline). */
  remainingKg: number;
  /** The product's expected roast loss, percent. */
  expectedLossPct: number;
  /** remaining ÷ (1 − loss), 0.01 kg. */
  requiredGreenKg: number;
  /** Planned green of IN_PROGRESS slots with no batch recorded yet. */
  inProgressKg: number;
  /** Planned green of live PLANNED slots already approved. */
  approvedKg: number;
  /** required − in progress − approved, never below 0. */
  greenToPlanKg: number;
};

/** The loss used for the conversion: the product's, kept inside 0–90 % (a stored 100 % would divide by zero). */
export function usableLoss(pct: number | null | undefined): number {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return 15;
  return Math.min(90, Math.max(0, pct));
}

export function planQuantities(i: { remainingKg: number; expectedLossPct: number; inProgressKg: number; approvedKg: number }): Quantities {
  const loss = usableLoss(i.expectedLossPct);
  const remainingKg = round2(Math.max(0, i.remainingKg));
  const requiredGreenKg = round2(remainingKg / (1 - loss / 100));
  const inProgressKg = round2(Math.max(0, i.inProgressKg));
  const approvedKg = round2(Math.max(0, i.approvedKg));
  const greenToPlanKg = Math.max(0, kgOf(cents(requiredGreenKg) - cents(inProgressKg) - cents(approvedKg)));
  return { remainingKg, expectedLossPct: loss, requiredGreenKg, inProgressKg, approvedKg, greenToPlanKg };
}

// ── §5.2 feasible split ─────────────────────────────────────────────────────────────────────

export type Limits = { minKg: number; targetKg: number; maxKg: number; nominalKg: number };

export type Split = {
  count: number;
  /** Every batch, kg with two decimals, in slot order (the extra cents on the last batches). */
  batches: number[];
  /** Runs of equal batches: [{ kg: 5.05, n: 7 }, { kg: 5.06, n: 4 }] → «7 × 5.05 + 4 × 5.06». */
  groups: { kg: number; n: number }[];
};

export type SplitResult =
  | {
      ok: true;
      greenKg: number;
      /** The split the planner proposes. */
      proposed: Split;
      /** «البديل»: the other feasible count of k / k + 1 when redistribution was needed, else null. */
      alternative: Split | null;
      /** The naive target split (k × target + remainder) the frame shows beside the proposal. */
      target: { count: number; fullBatches: number; remainderKg: number; lastBelowMin: boolean };
      /** true when the remainder was below the minimum and the green was redistributed. */
      redistributed: boolean;
    }
  | { ok: false; greenKg: number; reason: "NOTHING_TO_PLAN" | "INVALID_LIMITS" | "NO_FEASIBLE_COUNT"; minKg: number; maxKg: number };

function groupsOf(batches: number[]): Split["groups"] {
  const out: Split["groups"] = [];
  for (const b of batches) {
    const last = out[out.length - 1];
    if (last && last.kg === b) last.n++;
    else out.push({ kg: b, n: 1 });
  }
  return out;
}

/** n equal batches of G cents; the extra cents go to the last batches, so the plan sums exactly to G. */
export function equalSplit(gCents: number, n: number): Split {
  const base = Math.floor(gCents / n);
  const extra = gCents - base * n;
  const batches = Array.from({ length: n }, (_, i) => kgOf(base + (i >= n - extra ? 1 : 0)));
  return { count: n, batches, groups: groupsOf(batches) };
}

/** «7 × 5.05 + 4 × 5.06», «1 × 5.50». */
export function splitText(s: Split): string {
  return s.groups.map((g) => `${g.n} × ${kg2(g.kg)}`).join(" + ");
}

export function limitsValid(l: Limits): boolean {
  return [l.minKg, l.targetKg, l.maxKg, l.nominalKg].every((x) => Number.isFinite(x) && x > 0)
    && l.minKg <= l.targetKg && l.targetKg <= l.maxKg && l.maxKg <= l.nominalKg;
}

/**
 * ROASTERS.md §5.2 (D3, corrected; owner sign-off 8 Oct 2026). With G the green to plan:
 *   F = { n : n × min ≤ G ≤ n × max } — empty → blocked.
 *   k = floor(G ÷ target), r = G − k × target.
 *   r = 0 → k × target;  r ≥ min → k × target + one batch of r.
 *   0 < r < min → of k and k + 1 that are in F, the count whose G ÷ n is closest to target (a tie →
 *   fewer batches); neither in F → the count in F closest to G ÷ target. The other of k / k + 1, when
 *   in F, is «البديل».
 * Target is preferred, not a ceiling: a batch may sit above it up to max. Never outside [min, max],
 * never above nominal. Limits are compared in whole cents: min rounded up, max rounded down.
 */
export function splitGreen(greenKg: number, l: Limits): SplitResult {
  const G = cents(greenKg);
  if (!limitsValid(l)) return { ok: false, greenKg: kgOf(G), reason: "INVALID_LIMITS", minKg: l.minKg, maxKg: l.maxKg };
  if (G <= 0) return { ok: false, greenKg: 0, reason: "NOTHING_TO_PLAN", minKg: l.minKg, maxKg: l.maxKg };
  const minC = Math.ceil(Math.round(l.minKg * 1000) / 10);
  const maxC = Math.floor(Math.round(Math.min(l.maxKg, l.nominalKg) * 1000) / 10);
  const tC = cents(l.targetKg);
  const lo = Math.max(1, Math.ceil(G / maxC));
  const hi = Math.floor(G / minC);
  const inF = (n: number) => n >= 1 && n >= lo && n <= hi;
  if (lo > hi) return { ok: false, greenKg: kgOf(G), reason: "NO_FEASIBLE_COUNT", minKg: l.minKg, maxKg: l.maxKg };

  const k = Math.floor(G / tC);
  const r = G - k * tC;
  const target = { count: k + (r > 0 ? 1 : 0), fullBatches: k, remainderKg: kgOf(r), lastBelowMin: r > 0 && r < minC };

  if (r === 0) {
    const batches = Array.from({ length: k }, () => kgOf(tC));
    return { ok: true, greenKg: kgOf(G), proposed: { count: k, batches, groups: groupsOf(batches) }, alternative: null, target, redistributed: false };
  }
  if (r >= minC) {
    const batches = [...Array.from({ length: k }, () => kgOf(tC)), kgOf(r)];
    return { ok: true, greenKg: kgOf(G), proposed: { count: k + 1, batches, groups: groupsOf(batches) }, alternative: null, target, redistributed: false };
  }
  const dist = (n: number) => Math.abs(G / n - tC);
  const cands = [k, k + 1].filter(inF).sort((a, b) => dist(a) - dist(b) || a - b);
  let n: number;
  if (cands.length) n = cands[0];
  else {
    const all: number[] = [];
    for (let i = lo; i <= hi; i++) all.push(i);
    const want = G / tC;
    n = all.sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0];
  }
  const alt = cands.find((c) => c !== n) ?? null;
  return {
    ok: true, greenKg: kgOf(G), proposed: equalSplit(G, n),
    alternative: alt !== null ? equalSplit(G, alt) : null, target, redistributed: true,
  };
}

/** Each batch inside [min, max] and not above nominal (the approval re-checks every slot with this). */
export function batchWithinLimits(kg: number, l: Limits): boolean {
  const c = cents(kg);
  return c >= Math.ceil(Math.round(l.minKg * 1000) / 10) && c <= Math.floor(Math.round(l.maxKg * 1000) / 10) && c <= Math.floor(Math.round(l.nominalKg * 1000) / 10);
}

// ── Riyadh days and working hours ───────────────────────────────────────────────────────────

export type WorkingHours = { days: number[]; start: string; end: string };
/** ROASTERS.md §4 example (illustrative until the owner confirms, D6): Sunday–Thursday 07:00–15:00. */
export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [0, 1, 2, 3, 4], start: "07:00", end: "15:00" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (t: string) => { const m = HHMM.exec(t)!; return Number(m[1]) * 60 + Number(m[2]); };

/** A stored value → valid working hours, or null (the caller then uses the default). */
export function parseWorkingHours(v: unknown): WorkingHours | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.days) || typeof o.start !== "string" || typeof o.end !== "string") return null;
  const days = [...new Set(o.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!HHMM.test(o.start) || !HHMM.test(o.end) || minutesOf(o.end) <= minutesOf(o.start) || days.length === 0) return null;
  return { days, start: o.start, end: o.end };
}
export const hoursOf = (v: unknown): WorkingHours => parseWorkingHours(v) ?? DEFAULT_WORKING_HOURS;

/** «2026-10-06» (Riyadh) of an instant. */
export function riyadhKey(at: Date | number): string {
  return new Date(+at + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}
/** The UTC instant of Riyadh midnight of a day key. */
export function riyadhMidnight(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`) - RIYADH_OFFSET_MS;
}
/** Day of week (0 = Sunday) of a Riyadh day key. */
export const dowOf = (key: string) => new Date(`${key}T00:00:00.000Z`).getUTCDay();
export const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
/** «10:42» in Riyadh. */
export const riyadhTime = (at: Date | number) => new Date(+at + RIYADH_OFFSET_MS).toISOString().slice(11, 16);

/** The working window of one Riyadh day, or null on a day off. */
export function workWindow(key: string, h: WorkingHours): { start: number; end: number } | null {
  if (!h.days.includes(dowOf(key))) return null;
  const m = riyadhMidnight(key);
  return { start: m + minutesOf(h.start) * MIN, end: m + minutesOf(h.end) * MIN };
}

// ── §5.4 placement ──────────────────────────────────────────────────────────────────────────

export type Interval = { start: number; end: number };
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/**
 * The start of each of `count` slots of `cycleMinutes`, as early as possible from `from` (rounded up
 * to 5 minutes): inside the working window of a working day, never overlapping `busy` (the roaster's
 * live slots, its planned maintenance and the operator's live slots on any roaster) or each other.
 * Back to back is allowed. Gives up after `horizonDays` days (complete: false).
 */
export function placeSlots(o: { count: number; cycleMinutes: number; from: Date | number; hours: WorkingHours; busy: Interval[]; horizonDays?: number }): { starts: number[]; complete: boolean } {
  const len = o.cycleMinutes * MIN;
  const step = 5 * MIN;
  let t = Math.ceil(+o.from / step) * step;
  const busy = [...o.busy].sort((a, b) => a.start - b.start);
  const starts: number[] = [];
  const lastDay = addDays(riyadhKey(t), o.horizonDays ?? 14);
  let guard = 0;
  while (starts.length < o.count && guard++ < 100_000) {
    const key = riyadhKey(t);
    if (key > lastDay) break;
    const w = workWindow(key, o.hours);
    if (!w || t + len > w.end) { t = riyadhMidnight(addDays(key, 1)); continue; }
    if (t < w.start) t = w.start;
    if (t + len > w.end) continue;
    const slot = { start: t, end: t + len };
    const hit = busy.filter((b) => overlaps(b, slot));
    if (hit.length) { t = Math.max(...hit.map((b) => b.end)); continue; }
    starts.push(t);
    busy.push(slot);
    t += len;
  }
  return { starts, complete: starts.length === o.count };
}

// ── §4 status, §5.5–5.6 conflicts ───────────────────────────────────────────────────────────

export type StoredStatus = "PLANNED" | "IN_PROGRESS" | "RECORDED" | "CANCELLED";
export type SlotStatus = StoredStatus | "MISSED";

/**
 * The status shown and used: RECORDED once a batch is linked; MISSED — derived, never stored — for a
 * PLANNED slot whose end has passed with no batch, and for a started (IN_PROGRESS) slot still without
 * a batch at the end of its Riyadh day. A missed slot is not live: it neither conflicts nor counts as
 * in progress or approved, so its green returns to «الأخضر للتخطيط» for a re-plan.
 */
export function effectiveStatus(s: { status: string; endsAt: Date | number; hasBatch?: boolean }, now: Date | number = Date.now()): SlotStatus {
  if (s.hasBatch || s.status === "RECORDED") return "RECORDED";
  if (s.status === "CANCELLED") return "CANCELLED";
  if (s.status === "PLANNED") return +s.endsAt <= +now ? "MISSED" : "PLANNED";
  if (s.status === "IN_PROGRESS") return +now >= riyadhMidnight(addDays(riyadhKey(s.endsAt), 1)) ? "MISSED" : "IN_PROGRESS";
  return "PLANNED";
}
export const isLive = (st: SlotStatus) => st === "PLANNED" || st === "IN_PROGRESS";

export type SlotLike = { id?: string; key?: string; roasterId: string; operatorId: string; start: number; end: number };
export type Conflict = { kind: "MACHINE" | "OPERATOR"; a: SlotLike; b: SlotLike };

/**
 * Overlaps of the candidate slots with each other and with the existing LIVE slots: the same roaster
 * (machine, §5.5) or the same operator on any roaster (§5.6). Back-to-back is not an overlap. Callers
 * pass only live existing slots; a candidate is never compared with itself (by id or key).
 */
export function findConflicts(candidates: SlotLike[], existing: SlotLike[]): Conflict[] {
  const out: Conflict[] = [];
  const same = (a: SlotLike, b: SlotLike) => (a.id && b.id && a.id === b.id) || (a.key && b.key && a.key === b.key);
  const check = (a: SlotLike, b: SlotLike) => {
    if (same(a, b) || !overlaps({ start: a.start, end: a.end }, { start: b.start, end: b.end })) return;
    if (a.roasterId === b.roasterId) out.push({ kind: "MACHINE", a, b });
    else if (a.operatorId === b.operatorId) out.push({ kind: "OPERATOR", a, b });
  };
  candidates.forEach((a, i) => {
    for (let j = i + 1; j < candidates.length; j++) check(a, candidates[j]);
    for (const b of existing) check(a, b);
  });
  return out;
}

/** Whether a slot lies inside one working window (manual moves are held to the same hours). */
export function insideWorkingHours(s: Interval, h: WorkingHours): boolean {
  const w = workWindow(riyadhKey(s.start), h);
  return !!w && s.start >= w.start && s.end <= w.end;
}

// ── Plan rules (RM7 «قواعد التحقق») ─────────────────────────────────────────────────────────

export type Rule = { key: "LIMITS" | "LAST_BATCH" | "ROASTER" | "OPERATOR" | "TIME" | "SPANS"; state: "ok" | "warn" | "fail" };
