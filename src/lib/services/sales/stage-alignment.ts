// Aligning the configured pipeline stages with the approved pipeline — without destroying anything.
// Used by scripts/sales/align-pipeline-stages.ts (dry run by default); documented, with what the
// owner approves first, in docs/sales/PIPELINE_STAGES.md.
//
// ── The approved pipeline ──
//   1. Qualified Opportunity «فرصة مؤهلة»            purpose QUALIFICATION   (needs analysis is a detail of it)
//   2. Sample Evaluation «تجربة وتقييم العينات»       purpose SAMPLE_EVALUATION (skippable, with a documented reason)
//   3. Quotation «عرض السعر»                         purpose QUOTATION
//   4. Negotiation & Approval «التفاوض والاعتماد»    purpose NEGOTIATION
//   5. Closed «مغلقة» → Won «رابحة» / Lost «خاسرة»   the deal's OUTCOME, not a stage
//
// ── What "without destroying anything" means here ──
// A stage is referenced by every deal in it and by every OpportunityStageEvent that ever named
// it. So nothing is deleted and nothing that can be matched is re-created: a matched stage keeps
// its id and its code (the stable identity) and is renamed, re-ordered and given its purpose IN
// PLACE, which keeps every deal and every history row pointing at the same row. Only a stage the
// pipeline needs and nothing matches is created. A redundant «Closing» column (closing is an
// outcome) is retired only when no open deal sits in it — otherwise it is reported and left alone,
// because retiring it would hide those deals. Anything else that matches nothing is kept active,
// placed after the approved four, and reported for the owner to decide.
//
// The planner is pure (asserted in tests/sales/unit); `applyAlignment` writes a plan in one
// transaction and is idempotent — a second run plans no change.
import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import type { StagePurpose } from "./stages";

type Tx = PrismaNS.TransactionClient;

export type StageRow = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  position: number;
  probability: number;
  purpose: StagePurpose | null;
  isActive: boolean;
  /** Open deals in the stage — the only thing that stops a stage being retired. */
  openDeals: number;
};

export type ApprovedStage = {
  slot: "QUALIFIED" | "SAMPLES" | "QUOTATION" | "NEGOTIATION";
  purpose: StagePurpose;
  nameEn: string;
  nameAr: string;
  position: number;
  /** Used only for a stage that has to be created; a matched stage keeps its own probability. */
  probability: number;
  /** The code a created stage gets (after the prefix). A matched stage keeps its code. */
  code: string;
  /** Recognises an existing stage by its code or either name, when no stage holds the purpose yet. */
  match: RegExp;
};

export const APPROVED_STAGES: readonly ApprovedStage[] = [
  { slot: "QUALIFIED", purpose: "QUALIFICATION", nameEn: "Qualified Opportunity", nameAr: "فرصة مؤهلة", position: 10, probability: 20, code: "QUALIFIED",
    match: /QUAL|LEAD|DISCOVER|NEEDS|تأهيل|مؤهل|احتياج/i },
  { slot: "SAMPLES", purpose: "SAMPLE_EVALUATION", nameEn: "Sample Evaluation", nameAr: "تجربة وتقييم العينات", position: 20, probability: 35, code: "SAMPLE_EVALUATION",
    match: /SAMPLE|TRIAL|TASTING|عي[ّ]?ن|تجرب|تذوق/i },
  { slot: "QUOTATION", purpose: "QUOTATION", nameEn: "Quotation", nameAr: "عرض السعر", position: 30, probability: 50, code: "QUOTATION",
    match: /QUOT|PROPOSAL|OFFER|عرض/i },
  { slot: "NEGOTIATION", purpose: "NEGOTIATION", nameEn: "Negotiation & Approval", nameAr: "التفاوض والاعتماد", position: 40, probability: 75, code: "NEGOTIATION",
    match: /NEGO|APPROV|تفاوض|اعتماد/i },
];

/** A «Closing» / «Won» / «Lost» column: redundant, because closing is the deal's outcome. */
export const CLOSING_MATCH = /CLOS|WON|LOST|إغلاق|اغلاق|مغلق|رابح|خاسر/i;

const matches = (re: RegExp, s: StageRow) => re.test(s.code) || re.test(s.nameEn) || re.test(s.nameAr);

type Change<T> = { from: T; to: T };
export type StageChanges = Partial<{
  nameEn: Change<string>; nameAr: Change<string>; position: Change<number>;
  purpose: Change<StagePurpose | null>; isActive: Change<boolean>;
}>;

export type AlignmentPlan = {
  /** One entry per approved stage, in order: the existing stage it maps to, or a creation. */
  mapping: {
    slot: ApprovedStage["slot"];
    target: { nameEn: string; nameAr: string; purpose: StagePurpose; position: number };
    stageId: string | null;
    code: string;
    matchedBy: "purpose" | "name" | "create";
    changes: StageChanges;
    /** Set when matchedBy is "create". */
    create?: { code: string; nameEn: string; nameAr: string; position: number; probability: number; purpose: StagePurpose };
  }[];
  /** Redundant closing columns: retired when empty, otherwise reported. */
  closing: { stageId: string; code: string; openDeals: number; action: "DEACTIVATE" | "KEEP_HAS_OPEN_DEALS" | "ALREADY_INACTIVE"; changes: StageChanges }[];
  /** Stages that match nothing: kept as they are (active ones re-placed after the approved four). */
  extras: { stageId: string; code: string; nameAr: string; isActive: boolean; openDeals: number; changes: StageChanges }[];
  /** Number of rows the plan writes (updates + creations). Zero on an aligned pipeline. */
  writes: number;
};

function diff(s: StageRow, want: Partial<Pick<StageRow, "nameEn" | "nameAr" | "position" | "purpose" | "isActive">>): StageChanges {
  const c: StageChanges = {};
  for (const k of ["nameEn", "nameAr", "position", "purpose", "isActive"] as const) {
    if (k in want && want[k] !== s[k]) (c as Record<string, Change<unknown>>)[k] = { from: s[k], to: want[k] };
  }
  return c;
}

const byPosition = (a: StageRow, b: StageRow) => a.position - b.position || a.code.localeCompare(b.code);

/**
 * The proposal: which configured stage becomes which approved stage, and what changes.
 *
 * Matching, per approved stage in pipeline order: first the stage already holding its purpose
 * (somebody configured that deliberately); then an unmatched stage whose code or name says so,
 * preferring an active one and then the earliest. Each stage is used at most once, and a stage
 * that reads as «Closing» is never taken for anything else.
 */
export function planAlignment(rows: readonly StageRow[], opts: { createCodePrefix?: string } = {}): AlignmentPlan {
  const prefix = opts.createCodePrefix ?? "PIPE_";
  const stages = [...rows].sort(byPosition);
  const used = new Set<string>();
  const codes = new Set(stages.map((s) => s.code));
  const closingIds = new Set(stages.filter((s) => s.purpose === null && matches(CLOSING_MATCH, s)).map((s) => s.id));

  const mapping: AlignmentPlan["mapping"] = [];
  const picked = new Map<string, { stage: StageRow; by: "purpose" | "name" }>();
  for (const t of APPROVED_STAGES) {
    const holder = stages.find((s) => s.purpose === t.purpose);
    if (holder) { picked.set(t.slot, { stage: holder, by: "purpose" }); used.add(holder.id); }
  }
  for (const t of APPROVED_STAGES) {
    if (picked.has(t.slot)) continue;
    const candidates = stages.filter((s) => !used.has(s.id) && !closingIds.has(s.id) && s.purpose === null && matches(t.match, s));
    const best = candidates.find((s) => s.isActive) ?? candidates[0];
    if (best) { picked.set(t.slot, { stage: best, by: "name" }); used.add(best.id); }
  }

  let writes = 0;
  for (const t of APPROVED_STAGES) {
    const target = { nameEn: t.nameEn, nameAr: t.nameAr, purpose: t.purpose, position: t.position };
    const p = picked.get(t.slot);
    if (p) {
      const changes = diff(p.stage, { ...target, isActive: true });
      if (Object.keys(changes).length) writes++;
      mapping.push({ slot: t.slot, target, stageId: p.stage.id, code: p.stage.code, matchedBy: p.by, changes });
    } else {
      let code = `${prefix}${t.code}`;
      for (let n = 2; codes.has(code); n++) code = `${prefix}${t.code}_${n}`;
      codes.add(code);
      writes++;
      mapping.push({
        slot: t.slot, target, stageId: null, code, matchedBy: "create", changes: {},
        create: { code, nameEn: t.nameEn, nameAr: t.nameAr, position: t.position, probability: t.probability, purpose: t.purpose },
      });
    }
  }

  // Everything else keeps its row. Active leftovers go after the approved four, in their current
  // order, so the board reads the approved pipeline first; inactive ones are not touched. A
  // leftover holding a purpose cannot exist (each purpose's holder was matched above).
  let next = 50;
  const extras: AlignmentPlan["extras"] = [];
  const closing: AlignmentPlan["closing"] = [];
  for (const s of stages) {
    if (used.has(s.id) || closingIds.has(s.id)) continue;
    const changes = s.isActive ? diff(s, { position: next }) : {};
    if (s.isActive) next += 10;
    if (Object.keys(changes).length) writes++;
    extras.push({ stageId: s.id, code: s.code, nameAr: s.nameAr, isActive: s.isActive, openDeals: s.openDeals, changes });
  }
  for (const s of stages) {
    if (!closingIds.has(s.id)) continue;
    if (!s.isActive) { closing.push({ stageId: s.id, code: s.code, openDeals: s.openDeals, action: "ALREADY_INACTIVE", changes: {} }); continue; }
    // A retired column keeps its position and takes no slot: positions are handed out to active
    // stages only, so the next run (where it is already retired) hands out the same ones.
    const retire = s.openDeals === 0;
    const changes = diff(s, retire ? { isActive: false } : { position: next });
    if (!retire) next += 10;
    if (Object.keys(changes).length) writes++;
    closing.push({ stageId: s.id, code: s.code, openDeals: s.openDeals, action: s.openDeals === 0 ? "DEACTIVATE" : "KEEP_HAS_OPEN_DEALS", changes });
  }

  return { mapping, closing, extras, writes };
}

/** The stages with their open-deal counts. `where` narrows the set (tests use it; the script never does). */
export async function loadStageRows(db: Tx, where: PrismaNS.PipelineStageWhereInput = {}): Promise<StageRow[]> {
  const rows = await db.pipelineStage.findMany({
    where,
    select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, purpose: true, isActive: true },
    orderBy: [{ position: "asc" }, { code: "asc" }],
  });
  const open = rows.length
    ? await db.opportunity.groupBy({ by: ["stageId"], where: { outcome: "OPEN", stageId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
    : [];
  const openBy = new Map(open.map((o) => [o.stageId, o._count._all]));
  return rows.map((r) => ({ ...r, purpose: r.purpose as StagePurpose | null, openDeals: openBy.get(r.id) ?? 0 }));
}

const after = (c: StageChanges) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, (v as Change<unknown>).to]));

/**
 * Write a plan, in the caller's transaction. Never deletes; touches only the rows the plan names.
 *
 * Purposes are cleared first on every row whose purpose changes, then set: the unique index on
 * `purpose` would otherwise refuse a swap half-way through. A closing column is re-checked for
 * open deals here, inside the transaction, rather than trusted from the (possibly stale) plan.
 */
export async function applyAlignment(tx: Tx, plan: AlignmentPlan): Promise<{ updated: number; created: number; deactivated: number; keptClosing: number }> {
  const changing = [...plan.mapping, ...plan.extras, ...plan.closing].filter((m) => m.stageId && m.changes.purpose);
  if (changing.length) {
    await tx.pipelineStage.updateMany({ where: { id: { in: changing.map((m) => m.stageId as string) } }, data: { purpose: null } });
  }
  let updated = 0, created = 0, deactivated = 0, keptClosing = 0;
  for (const m of plan.mapping) {
    if (m.create) {
      await tx.pipelineStage.create({ data: m.create });
      created++;
    } else if (m.stageId && Object.keys(m.changes).length) {
      await tx.pipelineStage.update({ where: { id: m.stageId }, data: after(m.changes) });
      updated++;
    }
  }
  for (const e of plan.extras) {
    if (Object.keys(e.changes).length) {
      await tx.pipelineStage.update({ where: { id: e.stageId }, data: after(e.changes) });
      updated++;
    }
  }
  for (const c of plan.closing) {
    if (c.action === "ALREADY_INACTIVE") continue;
    let data = after(c.changes);
    if (c.action === "DEACTIVATE") {
      const open = await tx.opportunity.count({ where: { stageId: c.stageId, outcome: "OPEN" } });
      if (open > 0) { data = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "isActive")); keptClosing++; }
      else deactivated++;
    } else keptClosing++;
    if (Object.keys(data).length) {
      await tx.pipelineStage.update({ where: { id: c.stageId }, data });
      updated++;
    }
  }
  return { updated, created, deactivated, keptClosing };
}

/** The plan as the lines the script prints — for the owner to read before anything is applied. */
export function describePlan(plan: AlignmentPlan): string[] {
  const out: string[] = [];
  const fmt = (c: StageChanges) => Object.entries(c).map(([k, v]) => `${k}: ${JSON.stringify((v as Change<unknown>).from)} → ${JSON.stringify((v as Change<unknown>).to)}`).join("; ");
  out.push("Approved stages:");
  for (const m of plan.mapping) {
    const head = `  ${m.target.position}  ${m.target.nameAr} / ${m.target.nameEn}  [${m.target.purpose}]`;
    if (m.matchedBy === "create") out.push(`${head}\n      ← CREATE ${m.code} (no existing stage matches)`);
    else out.push(`${head}\n      ← ${m.code} (matched by ${m.matchedBy})${Object.keys(m.changes).length ? `: ${fmt(m.changes)}` : ": already aligned"}`);
  }
  out.push("  —   مغلقة / Closed → Won «رابحة» / Lost «خاسرة»: the deal's outcome, not a stage.");
  if (plan.closing.length) {
    out.push("Redundant closing stages:");
    for (const c of plan.closing) {
      out.push(`  ${c.code}: ${c.action === "DEACTIVATE" ? "retire (no open deal)" : c.action === "ALREADY_INACTIVE" ? "already retired" : `KEPT — ${c.openDeals} open deal(s); move them, then re-run`}${Object.keys(c.changes).length ? ` (${fmt(c.changes)})` : ""}`);
    }
  }
  if (plan.extras.length) {
    out.push("Other stages (kept; owner decides):");
    for (const e of plan.extras) {
      out.push(`  ${e.code} «${e.nameAr}» ${e.isActive ? "active" : "retired"}, ${e.openDeals} open deal(s)${Object.keys(e.changes).length ? `: ${fmt(e.changes)}` : ""}`);
    }
  }
  out.push(plan.writes === 0 ? "Nothing to change: the pipeline is aligned." : `${plan.writes} row(s) would be written.`);
  return out;
}
