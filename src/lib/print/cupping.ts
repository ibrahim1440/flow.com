/**
 * What a Cupping Results label may say about a cup — pure, so the rule is unit tested and the
 * server and the preview cannot disagree.
 *
 * Final score (coordinator rule, 16 Oct; owner decisions 3–4 of «Owner decisions 1–10»):
 *  • Closed + closeKind COMPLETE → FINAL: the score is the mean of the submitted finalScore of the
 *    ELIGIBLE staff evaluations of that cup — staff scorers (employeeId set) who completed every
 *    cup of the session (item 3). Guest evaluations are supplementary and never in the official
 *    average (item 4); owner decision 2.2: guest scores and notes never appear on a label — the
 *    server drops them before this module sees the scores, and notes here exclude them again.
 *  • Closed + INCOMPLETE → no score; marker «غير مكتملة · n من m (الحد k)».
 *  • Open → no score, no attributes, no notes (blind); marker «غير نهائية · الجلسة مفتوحة · n من m (الحد k)».
 *  • Closed before the close policy (closeKind NULL) → as the results screen shows it (C-4, no
 *    retroactive change; since c310ec50 that screen averages the staff evaluations and shows guests
 *    apart): the mean of every staff score on the cup, never «final», always with the exact disclosure
 *    «قبل اعتماد سياسة الحد الأدنى للمقيّمين» (owner decision 2.3; never abbreviated — a compact
 *    label that cannot hold it is blocked). No staff score → «لا توجد درجة معتمدة», nothing computed.
 *  • n = eligible staff scorers (distinct employeeId that completed every cup); m = distinct staff
 *    participants who submitted any evaluation; k = the minimum (minScorersAtClose when closed,
 *    the current setting when open) — design review ruling 4.
 *
 * Shared tasting notes (owner decision 5): see sharedNotes().
 */
import { ATTRIBUTE_KEYS, type AttributeKey } from "./templates";

export type CuppingState = "FINAL" | "INCOMPLETE" | "OPEN" | "CLOSED_LEGACY";

export type ScoreIn = {
  id: string;
  employeeId: string | null;
  scorerName: string | null;
  sessionBatchId: string | null;
  finalScore: number;
  attrs: Record<AttributeKey, number>;
  notes: string | null;
  descriptors: string[];
};

export type SessionIn = {
  status: string;
  closeKind: string | null;
  minScorersAtClose: number | null;
  scorersAtClose: number | null;
  /** Ids of the session's cups (CuppingSessionBatch). Empty for a single-cup session. */
  cupIds: string[];
};

/** One staff evaluation's notes as recorded (guests are never included, decision 2.2). */
/** `no` is the scorer's number in the session (the same person keeps it on every cup). */
export type ScorerNote = { no: number; scorer: string; descriptors: string[]; notes: string | null };
export type SharedNote = { text: string; count: number };

export type CupResult = {
  state: CuppingState;
  /** Eligible staff scorers (n), staff participants (m), the applicable minimum (k). */
  n: number;
  m: number;
  k: number | null;
  score: number | null;
  attributes: Partial<Record<AttributeKey, number>> | null;
  /** FINAL only; [] = no note qualifies («لا توجد إيحاءات مشتركة»). */
  sharedNotes: SharedNote[] | null;
  /** Eligible evaluations the shared-notes rule ran over (k). */
  eligibleEvaluations: number;
  /** Individual notes as recorded (never for an open session; on a final label eligible staff only). */
  scorerNotes: ScorerNote[] | null;
  /** Staff evaluations recorded on this cup (the pre-policy «3 scorers · recorded score» count). */
  cupScorers: number;
};

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Staff scorers who submitted a score for every cup (item 3). Single-cup: any score. */
export function eligibleScorers(session: Pick<SessionIn, "cupIds">, scores: ScoreIn[]): Set<string> {
  const byScorer = new Map<string, Set<string>>();
  for (const s of scores) {
    if (!s.employeeId) continue;
    const cups = byScorer.get(s.employeeId) ?? new Set<string>();
    cups.add(s.sessionBatchId ?? "");
    byScorer.set(s.employeeId, cups);
  }
  const out = new Set<string>();
  for (const [id, cups] of byScorer) {
    if (session.cupIds.length === 0 || session.cupIds.every((c) => cups.has(c))) out.add(id);
  }
  return out;
}

/** Scores of one cup (multi-cup) or of the session (single-cup: cupId null). */
export function scoresOfCup(scores: ScoreIn[], cupId: string | null): ScoreIn[] {
  return cupId === null ? scores : scores.filter((s) => s.sessionBatchId === cupId);
}

export function stateOf(session: Pick<SessionIn, "status" | "closeKind">): CuppingState {
  if (session.status !== "Closed") return "OPEN";
  if (session.closeKind === "COMPLETE") return "FINAL";
  if (session.closeKind === "INCOMPLETE") return "INCOMPLETE";
  return "CLOSED_LEGACY";
}

/**
 * Approved deterministic wording normalization (owner decision 5): exact match after trimming and
 * case-folding (Unicode NFC first, so the same text typed with composed / decomposed characters
 * matches). No approved mapping table exists, so no synonyms are merged and nothing semantic is
 * inferred: «Lemon» and « lemon » are one note, «Lemon» and «Citrus» are two.
 */
export function normalizeNote(raw: string): string {
  return raw.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

/**
 * Shared tasting notes (owner decision 5). Input: one entry per ELIGIBLE, fully completed staff
 * evaluation of the cup (the caller filters guests and incomplete scorers). A note is shared only
 * when BOTH hold:
 *   (a) it appears in MORE than 50 % of those evaluations, and
 *   (b) at least two distinct scorers recorded it.
 * So k = 2 → 2, 3 → 2, 4 → 3, 5 → 3. A note repeated inside one evaluation counts once. Exactly
 * 50 % (a tie) does not qualify. Order: most frequent first, then first appearance. The printed
 * wording is the first recorded form. Empty input, or nothing qualifying → [].
 */
export function sharedNotes(evaluations: { scorerId: string; notes: string[] }[]): SharedNote[] {
  const k = evaluations.length;
  if (k === 0) return [];
  const tally = new Map<string, { text: string; scorers: Set<string>; first: number }>();
  let order = 0;
  for (const ev of evaluations) {
    for (const raw of ev.notes) {
      const key = normalizeNote(raw);
      if (!key) continue;
      const t = tally.get(key) ?? { text: raw.trim(), scorers: new Set<string>(), first: order++ };
      t.scorers.add(ev.scorerId);
      tally.set(key, t);
    }
  }
  return [...tally.values()]
    .filter((t) => t.scorers.size * 2 > k && t.scorers.size >= 2)
    .sort((a, b) => b.scorers.size - a.scorers.size || a.first - b.first)
    .map((t) => ({ text: t.text, count: t.scorers.size }));
}

/** The printable result for one cup. `currentMin` = CuppingSettings.minScorers (open sessions). */
export function cupResult(session: SessionIn, allScores: ScoreIn[], cupId: string | null, currentMin: number): CupResult {
  const state = stateOf(session);
  const eligible = eligibleScorers(session, allScores);
  const cup = scoresOfCup(allScores, cupId);
  const eligibleOnCup = cup.filter((s) => s.employeeId && eligible.has(s.employeeId));
  const participants = new Set(allScores.filter((s) => s.employeeId).map((s) => s.employeeId as string)).size;
  const cupScorers = cup.filter((s) => s.employeeId).length;
  // «مقيّم N» is numbered per session, in the order scorers first submitted (scores arrive oldest
  // first), so a person keeps the same number on every cup. A final label numbers only the eligible
  // scorers (decisions 3 and 5); other states number every staff scorer.
  const numbering = (pool: (id: string) => boolean) => {
    const m = new Map<string, number>();
    for (const s of allScores) if (s.employeeId && pool(s.employeeId) && !m.has(s.employeeId)) m.set(s.employeeId, m.size + 1);
    return m;
  };
  const notesOf = (list: ScoreIn[], nums: Map<string, number>): ScorerNote[] =>
    list.filter((s) => s.employeeId && nums.has(s.employeeId))
      .map((s) => ({ no: nums.get(s.employeeId as string)!, scorer: s.scorerName ?? "", descriptors: s.descriptors, notes: s.notes?.trim() || null }))
      .sort((a, b) => a.no - b.no);
  const everyStaff = numbering(() => true);
  const attrsOf = (list: ScoreIn[]) => {
    if (list.length === 0) return null;
    const out: Partial<Record<AttributeKey, number>> = {};
    for (const k of ATTRIBUTE_KEYS) out[k] = mean(list.map((s) => s.attrs[k]))!;
    return out;
  };

  if (state === "OPEN") {
    return { state, n: eligible.size, m: participants, k: currentMin, score: null, attributes: null, sharedNotes: null, eligibleEvaluations: 0, scorerNotes: null, cupScorers };
  }
  if (state === "INCOMPLETE") {
    return {
      state, n: eligible.size, m: participants, k: session.minScorersAtClose, score: null, attributes: null,
      sharedNotes: null, eligibleEvaluations: 0, scorerNotes: notesOf(cup, everyStaff), cupScorers,
    };
  }
  if (state === "CLOSED_LEGACY") {
    return {
      state, n: eligible.size, m: participants, k: null, score: mean(cup.filter((s) => s.employeeId).map((s) => s.finalScore)), attributes: attrsOf(cup.filter((s) => s.employeeId)),
      sharedNotes: null, eligibleEvaluations: 0, scorerNotes: notesOf(cup, everyStaff), cupScorers,
    };
  }
  // FINAL
  const evaluations = eligibleOnCup.map((s) => ({ scorerId: s.employeeId as string, notes: s.descriptors }));
  return {
    state,
    n: eligible.size,
    m: participants,
    k: session.minScorersAtClose,
    score: mean(eligibleOnCup.map((s) => s.finalScore)),
    attributes: attrsOf(eligibleOnCup),
    sharedNotes: sharedNotes(evaluations),
    eligibleEvaluations: evaluations.length,
    // QA ruling (P3-3): per-scorer notes on a COMPLETE label come from the eligible scorers only —
    // a staff member who skipped a cup is left out, as from the score and the shared notes.
    scorerNotes: notesOf(eligibleOnCup, numbering((id) => eligible.has(id))),
    cupScorers,
  };
}

export const NO_SHARED_NOTES = { ar: "لا توجد إيحاءات مشتركة", en: "No shared notes" };

/** The disclosure printed with a pre-policy score — exactly this text, on every size (decision 2.3). */
export const LEGACY_CAVEAT = { ar: "قبل اعتماد سياسة الحد الأدنى للمقيّمين", en: "Before the minimum-scorer policy" };
/** A pre-policy cup without any staff score: no score is generated (decision 2.3). */
export const NO_APPROVED_SCORE = { ar: "لا توجد درجة معتمدة", en: "No finalized score" };
/** Standard sizes name what the pre-policy number is (design §P2-7). */
export const RECORDED_SCORE = { ar: "الدرجة المسجّلة", en: "Recorded score" };

/**
 * Not-final marker (design §P2-4, set 1646:6432): a large state word and a small meta line.
 * n = eligible staff, m = staff participants, k = the minimum at close (INCOMPLETE only), never
 * folded into m.
 * - single language: «غير مكتملة» + «أُغلقت دون الحد الأدنى · أكمل 1 من 3 (الحد 2)»,
 *   «Not final» + «Session open · 2 of 3 scorers complete»;
 * - bilingual: «غير نهائية · Not final» + «Session open · 2/3 · الجلسة مفتوحة»;
 * - 50 × 30: the state word only.
 */
export type MarkerMode = "single" | "bi" | "compact";
export const STATE_WORD: Record<"OPEN" | "INCOMPLETE", { ar: string; en: string }> = {
  OPEN: { ar: "غير نهائية", en: "Not final" },
  INCOMPLETE: { ar: "غير مكتملة", en: "Incomplete" },
};
export function stateMarker(r: Pick<CupResult, "state" | "n" | "m" | "k">, lang: "ar" | "en", mode: MarkerMode = "single"): { text: string; meta: string | null } {
  if (r.state !== "OPEN" && r.state !== "INCOMPLETE") return { text: lang === "ar" ? LEGACY_CAVEAT.ar : LEGACY_CAVEAT.en, meta: null };
  const ar = lang === "ar";
  const text = STATE_WORD[r.state][lang];
  if (mode === "compact") return { text, meta: null };
  const min = r.state === "INCOMPLETE" && r.k !== null ? (ar ? ` (الحد ${r.k})` : ` (min ${r.k})`) : "";
  if (mode === "bi") {
    // The bilingual meta reads «Session open · 2/3 · الجلسة مفتوحة»: counts once, on the English side.
    if (ar) return { text, meta: r.state === "OPEN" ? "الجلسة مفتوحة" : "دون الحد الأدنى" };
    return { text, meta: `${r.state === "OPEN" ? "Session open" : "Incomplete"} · ${r.n}/${r.m}${min}` };
  }
  if (r.state === "OPEN") return { text, meta: ar ? `الجلسة مفتوحة · أكمل ${r.n} من ${r.m} مقيّمين` : `Session open · ${r.n} of ${r.m} scorers complete` };
  return { text, meta: ar ? `أُغلقت دون الحد الأدنى · أكمل ${r.n} من ${r.m}${min}` : `Closed below the minimum · ${r.n} of ${r.m} scorers complete${min}` };
}

/** Pre-policy meta on single-language standard labels: «/ 100 · SCA · 3 scorers · recorded score». */
export function legacyMeta(scorers: number, lang: "ar" | "en"): string {
  return lang === "ar"
    ? `${scorers} ${scorers === 1 ? "مقيّم" : "مقيّمين"} · ${RECORDED_SCORE.ar}`
    : `${scorers} ${scorers === 1 ? "scorer" : "scorers"} · ${RECORDED_SCORE.en.toLowerCase()}`;
}

/** Short completion note beside a final score on a label (1646:6432): «3/3 complete · أكمل 3 من 3». */
export function finalMetaShort(r: Pick<CupResult, "state" | "n" | "m">, lang: "ar" | "en"): string | null {
  if (r.state !== "FINAL") return null;
  return lang === "ar" ? `أكمل ${r.n} من ${r.m}` : `${r.n}/${r.m} complete`;
}

/** Completion line under a final score: «أكمل 3 من 3 مقيّمين كل الأكواب». */
export function finalMeta(r: Pick<CupResult, "state" | "n" | "m">, lang: "ar" | "en"): string | null {
  if (r.state !== "FINAL") return null;
  return lang === "ar" ? `أكمل ${r.n} من ${r.m} مقيّمين كل الأكواب` : `${r.n} of ${r.m} scorers completed all cups`;
}

/** A shared note with its support: «ياسمين (3 من 3)», bilingual / compact «ياسمين 3/3». */
export function sharedNoteText(text: string, count: number, k: number, lang: "ar" | "en", short: boolean): string {
  if (short) return `${text} ${count}/${k}`;
  return lang === "ar" ? `${text} (${count} من ${k})` : `${text} (${count} of ${k})`;
}
