// Native HR — journal integrity for every HR money event (P-2 / E-3, finding 9).
//
// An HrJournalLink proves only that SOME journal was linked. Before a journal is relied on —
// a run's accrual before its payment, a disbursement before its repayment, a journal before it
// is reversed, a link found on retry — it is VERIFIED here:
//   · POSTED, and not reversed unless HR itself linked the reversal (no silent cancellation);
//   · of the HR module, about this source (sourceDocumentId = the run / advance / repayment id);
//   · of the right type (AUTO, or REVERSAL for a reversal) and dated as required (an accrual on
//     the run's period end), inside the fiscal period it is filed under;
//   · balanced (lines = header totals, debit = credit);
//   · its lines equal what was frozen on the link when it was posted (`postedLines`: key,
//     account, side, amount) — so a later account-map change does not make an old journal look
//     wrong, and an edited journal does;
//   · those frozen amounts equal what the approved source calls for, per posting key and side
//     (an accrual: the run's items, which are immutable once approved);
//   · no second, unlinked HR journal exists for the same source (a duplicate from a retry).
//
// Review P2-A4 — links written BEFORE posted lines were frozen (migration 20261017090000) carry no
// `postedLines`. Migration 20261017120000 captured, once and append-only, a BASELINE for each of
// them (HrJournalLinkBaseline): the journal's lines per account and side as they stood, and the
// account map as it stood. Such a link is verified against its baseline and its expected amounts
// are priced through the BASELINE map, so a later account-map change does not make it look wrong
// (nor hide an edit). A legacy link WITHOUT a baseline is reported (NO_BASELINE) and the account
// map cannot change while one exists (service and DB). The baseline is a snapshot, not an
// approval: the accountant reviews it before production (docs/hr/P2-REVIEW-FIXES.md).
// There is ONE company: AccountingSettings is a singleton and journals carry no company or tenant
// column, so "the right company" is the HR module of this database. A multi-company model would
// add the check here.
//
// Refusals are audited in a write of their own (the refused transaction rolls back).
//
// External accounting: no path that records an HR money event WITHOUT its journal is approved.
// `externalAccountingTreatment` is the documented hook such a path would use; it refuses.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HrError, type Db, audit } from "../core";
import { dayString } from "../dates";

const ZERO = new Prisma.Decimal(0);

export type JournalRef = { sourceType: string; sourceId: string; purpose: string };
export type PostedLine = { key: string; accountId: string; side: "D" | "C"; amount: string };
type LineLike = { key: string; debit?: Prisma.Decimal; credit?: Prisma.Decimal };
export type JournalProblem = { code: string; detail: string };

export const ACCOUNTING_REQUIRED = "ACCOUNTING_REQUIRED";
export const EXTERNAL_ACCOUNTING_NOT_APPROVED = "EXTERNAL_ACCOUNTING_NOT_APPROVED";
export const JOURNAL_MISSING = "JOURNAL_MISSING";
export const JOURNAL_INTEGRITY = "JOURNAL_INTEGRITY";

// ── Refusal audit ────────────────────────────────────────────────────────────────

const audited = new WeakSet<object>();
export const wasAudited = (e: unknown) => typeof e === "object" && e !== null && audited.has(e);

const ENTITY: Record<string, string> = { PAYROLL_RUN: "HrPayrollRun", ADVANCE: "HrAdvance", ADVANCE_REPAYMENT: "HrAdvanceRepayment", FINAL_SETTLEMENT: "HrFinalSettlement", GOSI_SETTLEMENT: "HrGosiSettlement", GOSI_INVOICE: "HrGosiInvoice" };
export const LEGACY_BASELINE_MISSING = "LEGACY_BASELINE_MISSING";

/** Links from before posted lines were frozen that have no baseline (P2-A4). */
export async function legacyLinksWithoutBaseline(db: Db): Promise<number> {
  return db.hrJournalLink.count({ where: { postedLines: { equals: Prisma.AnyNull }, baseline: null } });
}

/** Refuse (409) any account-map change while a legacy link has no baseline (P2-A4; the DB refuses it too). */
export async function assertLegacyLinksBaselined(db: Db): Promise<void> {
  const n = await legacyLinksWithoutBaseline(db);
  if (n > 0) throw new HrError(`${n} HR journal link(s) from before posted lines were frozen have no baseline, so the account map cannot change: their journals could no longer be verified. Capture and review their baseline first (docs/hr/P2-REVIEW-FIXES.md).`, 409, LEGACY_BASELINE_MISSING);
}

/**
 * Keep a refused control in the audit trail and return the error to throw. Written through the
 * global client, outside the caller's transaction (which the refusal rolls back). Only the step,
 * the code and the source — no amounts, payee or bank data.
 */
export async function controlRefusal(e: HrError, ctx: { entityType: string; entityId: string; step: string; actorId: string; detail?: Record<string, unknown> }): Promise<HrError> {
  if (!audited.has(e)) {
    audited.add(e);
    await audit(prisma, { action: "HR_CONTROL_REFUSED", entityType: ctx.entityType, entityId: ctx.entityId, after: { step: ctx.step, code: e.code ?? null, ...(ctx.detail ?? {}) }, actorId: ctx.actorId }).catch(() => undefined);
  }
  return e;
}

const refFor = (r: JournalRef, actorId: string, step: string, detail?: Record<string, unknown>) => ({ entityType: ENTITY[r.sourceType] ?? r.sourceType, entityId: r.sourceId, step, actorId, detail: { purpose: r.purpose, ...(detail ?? {}) } });

/** HR accounting is off: no HR money event is recorded (finding 9 — never a silent skip). */
export async function accountingOffRefusal(r: JournalRef, actorId: string): Promise<HrError> {
  return controlRefusal(new HrError("HR accounting is off, so this HR money event cannot be recorded: approval, payment, disbursement, repayment and reversal each need their journal. Turn HR accounting back on (an approved configuration change) first.", 409, ACCOUNTING_REQUIRED), refFor(r, actorId, "POST"));
}

/**
 * The documented hook for recording an HR money event whose journal is kept OUTSIDE this ledger.
 * No such treatment is approved (owner decision F2): this always refuses. Enabling one needs an
 * explicit owner + accountant approval, a reviewed implementation and its own tests — not a flag.
 */
export async function externalAccountingTreatment(r: JournalRef, actorId: string): Promise<never> {
  throw await controlRefusal(new HrError(`No approved external-accounting treatment exists, so ${r.sourceType} ${r.purpose} cannot be recorded without its journal in this ledger (its source was booked without one). It needs an explicitly approved treatment.`, 409, EXTERNAL_ACCOUNTING_NOT_APPROVED), refFor(r, actorId, "EXTERNAL_ACCOUNTING"));
}

// ── Posted lines ─────────────────────────────────────────────────────────────────

const sideOf = (l: LineLike): "D" | "C" => (l.debit && l.debit.greaterThan(0) ? "D" : "C");
const amountOf = (l: LineLike) => (sideOf(l) === "D" ? l.debit ?? ZERO : l.credit ?? ZERO);

/** What a journal posts, per (key, account, side), in a stable order. Zero lines dropped. */
export function postedLinesOf(lines: LineLike[], accountOf: Map<string, string>): PostedLine[] {
  const m = new Map<string, { key: string; accountId: string; side: "D" | "C"; amount: Prisma.Decimal }>();
  for (const l of lines) {
    const amt = amountOf(l);
    if (amt.isZero()) continue;
    const accountId = accountOf.get(l.key) ?? "";
    const k = `${l.key}|${accountId}|${sideOf(l)}`;
    const cur = m.get(k);
    if (cur) cur.amount = cur.amount.plus(amt); else m.set(k, { key: l.key, accountId, side: sideOf(l), amount: amt });
  }
  return [...m.values()].sort((a, b) => `${a.side}|${a.key}|${a.accountId}`.localeCompare(`${b.side}|${b.key}|${b.accountId}`)).map((x) => ({ ...x, amount: x.amount.toFixed(2) }));
}

/** Mirror (debit ↔ credit) of posted lines: what a reversal posts. */
export const mirrored = (p: PostedLine[]): PostedLine[] => p.map((x) => ({ ...x, side: x.side === "D" ? "C" : "D" }) as PostedLine).sort((a, b) => `${a.side}|${a.key}|${a.accountId}`.localeCompare(`${b.side}|${b.key}|${b.accountId}`));

function totals<T>(rows: T[], keyOf: (r: T) => string, amt: (r: T) => Prisma.Decimal) {
  const m = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    const a = amt(r);
    if (a.isZero()) continue;
    m.set(keyOf(r), (m.get(keyOf(r)) ?? ZERO).plus(a));
  }
  return m;
}
function sameTotals(a: Map<string, Prisma.Decimal>, b: Map<string, Prisma.Decimal>): string | null {
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? ZERO, y = b.get(k) ?? ZERO;
    if (!x.equals(y)) return `${k}: expected ${x.toFixed(2)}, found ${y.toFixed(2)}`;
  }
  return null;
}

// ── Verification ─────────────────────────────────────────────────────────────────

/**
 * Everything wrong with the journal linked to `ref` (empty = intact). Read only.
 * `expected`: the lines the approved source calls for (compared per key and side).
 * `date`: the entry date the source requires. `reversed`: the journal may be REVERSED by its
 * HR-linked reversal (e.g. listing a cancelled run); otherwise it must still be POSTED.
 */
export async function journalProblems(db: Db, ref: JournalRef, opts: { expected?: LineLike[]; expectedPosted?: PostedLine[]; date?: Date; reversed?: boolean } = {}): Promise<JournalProblem[]> {
  const link = await db.hrJournalLink.findUnique({ where: { sourceType_sourceId_purpose: ref } });
  if (!link) return [{ code: "MISSING", detail: `no ${ref.purpose} journal is linked` }];
  const p: JournalProblem[] = [];
  const e = await db.journalEntry.findUnique({ where: { id: link.journalEntryId }, include: { lines: true, fiscalPeriod: true, reversedByEntry: { include: { hrLinks: true } } } });
  if (!e) return [{ code: "MISSING", detail: "the linked journal does not exist" }];
  const reversal = e.reversedByEntry;
  if (reversal && reversal.hrLinks.length === 0) p.push({ code: "REVERSED_WITHOUT_TREATMENT", detail: `reversed by entry #${reversal.entryNo}, which HR did not link` });
  if (e.status === "REVERSED" && !reversal) p.push({ code: "REVERSED_WITHOUT_TREATMENT", detail: "marked REVERSED without a reversal entry" });
  if (opts.reversed) {
    if (e.status !== "POSTED" && e.status !== "REVERSED") p.push({ code: "NOT_POSTED", detail: `status ${e.status}` });
  } else if (e.status !== "POSTED" || reversal) p.push({ code: e.status === "POSTED" || e.status === "REVERSED" ? "REVERSED" : "NOT_POSTED", detail: `status ${e.status}${reversal ? `, reversed by entry #${reversal.entryNo}` : ""}` });
  if (e.sourceModule !== "hr" || e.sourceDocumentId !== ref.sourceId) p.push({ code: "WRONG_SOURCE", detail: `module ${e.sourceModule}, document ${e.sourceDocumentId ?? "—"}` });
  const wantType = ref.purpose === "REVERSAL" ? "REVERSAL" : "AUTO";
  if (e.type !== wantType) p.push({ code: "WRONG_TYPE", detail: `type ${e.type}, expected ${wantType}` });
  if (e.entryDate < e.fiscalPeriod.startDate || e.entryDate > e.fiscalPeriod.endDate) p.push({ code: "WRONG_PERIOD", detail: `dated ${dayString(e.entryDate)} outside its fiscal period ${e.fiscalPeriod.year}/${e.fiscalPeriod.periodNo}` });
  if (opts.date && dayString(e.entryDate) !== dayString(opts.date)) p.push({ code: "WRONG_DATE", detail: `dated ${dayString(e.entryDate)}, expected ${dayString(opts.date)}` });
  const dr = e.lines.reduce((s, l) => s.plus(l.debit), ZERO), cr = e.lines.reduce((s, l) => s.plus(l.credit), ZERO);
  if (!dr.equals(cr) || !dr.equals(e.totalDebit) || !cr.equals(e.totalCredit)) p.push({ code: "UNBALANCED", detail: `lines ${dr.toFixed(2)} / ${cr.toFixed(2)}, header ${e.totalDebit.toFixed(2)} / ${e.totalCredit.toFixed(2)}` });
  const entryByAccount = totals(e.lines.flatMap((l) => [{ k: `${l.accountId}|D`, a: l.debit }, { k: `${l.accountId}|C`, a: l.credit }]), (r) => r.k, (r) => r.a);
  const posted = Array.isArray(link.postedLines) ? (link.postedLines as unknown as PostedLine[]) : null;
  // P2-A4: a legacy link (no posted lines) is verified against its migration-time baseline.
  const baseline = posted ? null : await db.hrJournalLinkBaseline.findUnique({ where: { linkId: link.id } });
  const frozen = posted ?? (baseline ? (baseline.lines as unknown as PostedLine[]) : null);
  if (!posted && !baseline) p.push({ code: "NO_BASELINE", detail: "a link from before posted lines were frozen, with no baseline: it cannot be verified (the account map is locked until one is captured)" });
  if (frozen) {
    const d = sameTotals(totals(frozen, (x) => `${x.accountId}|${x.side}`, (x) => new Prisma.Decimal(x.amount)), entryByAccount);
    if (d) p.push({ code: "LINES_CHANGED", detail: `the journal's lines differ from what was ${posted ? "posted" : "recorded in its baseline"} (${d})` });
  }
  if (opts.expectedPosted && frozen) {
    const keyOf = posted ? (x: PostedLine) => `${x.key}|${x.accountId}|${x.side}` : (x: PostedLine) => `${x.accountId}|${x.side}`;
    const d = sameTotals(totals(opts.expectedPosted, keyOf, (x) => new Prisma.Decimal(x.amount)), totals(frozen, keyOf, (x) => new Prisma.Decimal(x.amount)));
    if (d) p.push({ code: "AMOUNT_MISMATCH", detail: d });
  }
  if (opts.expected) {
    const want = totals(opts.expected, (l) => `${l.key}|${sideOf(l)}`, amountOf);
    if (posted && !posted.some((x) => x.key.startsWith("AMBIGUOUS:") || x.key === "UNMAPPED")) {
      // Per posting key and side.
      const d = sameTotals(want, totals(posted, (x) => `${x.key}|${x.side}`, (x) => new Prisma.Decimal(x.amount)));
      if (d) p.push({ code: "AMOUNT_MISMATCH", detail: `posted amounts differ from the approved source (${d})` });
    } else if (posted) {
      // Lines mirrored from a baseline where two keys shared one account: price each key through
      // the account its frozen line names, compared per account and side.
      const map = new Map<string, string>();
      for (const x of posted) for (const k of x.key.startsWith("AMBIGUOUS:") ? x.key.slice(10).split("|") : [x.key]) map.set(k, x.accountId);
      const d = sameTotals(totals(opts.expected, (l) => `${map.get(l.key) ?? `unmapped:${l.key}`}|${sideOf(l)}`, amountOf), totals(posted, (x) => `${x.accountId}|${x.side}`, (x) => new Prisma.Decimal(x.amount)));
      if (d) p.push({ code: "AMOUNT_MISMATCH", detail: `posted amounts differ from the approved source (${d})` });
    } else {
      // A legacy link: price each posting key through the account map AS IT STOOD (the baseline
      // snapshot), never the current one, so a later map change does not shift the expectation.
      // Without a baseline the current map is the only reference (and NO_BASELINE is reported).
      const map = baseline ? new Map(Object.entries(baseline.accountMap as Record<string, string>)) : new Map((await db.hrAccountMap.findMany()).map((m) => [m.key, m.accountId]));
      const wantByAccount = totals(opts.expected, (l) => `${map.get(l.key) ?? `unmapped:${l.key}`}|${sideOf(l)}`, amountOf);
      const d = sameTotals(wantByAccount, entryByAccount);
      if (d) p.push({ code: "AMOUNT_MISMATCH", detail: `journal differs from the approved source through the ${baseline ? "baseline" : "current"} account map (${d}); a link from before posted lines were recorded` });
    }
  }
  const unlinked = await db.journalEntry.count({ where: { sourceModule: "hr", sourceDocumentId: ref.sourceId, hrLinks: { none: {} } } });
  if (unlinked > 0) p.push({ code: "DUPLICATE_UNLINKED", detail: `${unlinked} other HR journal(s) for this source carry no link` });
  return p;
}

/** Refuse (409, audited) unless the journal linked to `ref` is intact. */
export async function assertJournalIntact(db: Db, ref: JournalRef, opts: { expected?: LineLike[]; expectedPosted?: PostedLine[]; date?: Date; actorId: string; step: string }): Promise<void> {
  const problems = await journalProblems(db, ref, opts);
  if (!problems.length) return;
  const missing = problems[0].code === "MISSING";
  throw await controlRefusal(
    new HrError(
      missing
        ? `The required ${ref.purpose} journal of this ${ref.sourceType} is missing, so this step is refused. Nothing was changed.`
        : `The ${ref.purpose} journal of this ${ref.sourceType} failed its integrity check (${problems.map((x) => `${x.code}: ${x.detail}`).join("; ")}). Nothing was changed; report it to the accountant.`,
      409, missing ? JOURNAL_MISSING : JOURNAL_INTEGRITY,
    ),
    refFor(ref, opts.actorId, opts.step, { problems: problems.map((x) => x.code) }),
  );
}

/**
 * The journal a follow-up journal depends on: a payroll payment on the run's accrual; an
 * advance repayment on the advance's disbursement. Null when there is none.
 */
export async function requiredParentOf(db: Db, ref: JournalRef): Promise<JournalRef | null> {
  if (ref.sourceType === "PAYROLL_RUN" && (ref.purpose.startsWith("PAYMENT:") || ref.purpose.startsWith("RETURN:"))) return { sourceType: "PAYROLL_RUN", sourceId: ref.sourceId, purpose: "ACCRUAL" };
  if (ref.sourceType === "ADVANCE_REPAYMENT" && ref.purpose === "REPAYMENT") {
    const rep = await db.hrAdvanceRepayment.findUnique({ where: { id: ref.sourceId }, select: { advanceId: true } });
    if (rep) return { sourceType: "ADVANCE", sourceId: rep.advanceId, purpose: "DISBURSEMENT" };
  }
  return null;
}

/**
 * Read-only report (P-2 / E-3): every HR journal link that fails verification, every unlinked HR
 * journal, and every APPROVED / PAID run, payment, disbursed advance and repayment without its
 * required journal. Writes nothing.
 */
export async function journalIntegrityReport(db: Db = prisma) {
  const links = await db.hrJournalLink.findMany({ orderBy: { createdAt: "asc" } });
  const broken: { sourceType: string; sourceId: string; purpose: string; problems: JournalProblem[] }[] = [];
  // Review P2-A4: every link's amounts are compared with what its approved source calls for,
  // per posting key and side (loaded lazily: the source rules live in the services that post).
  const { expectedLinesFor } = await import("./journal-expected");
  for (const l of links) {
    const ref = { sourceType: l.sourceType, sourceId: l.sourceId, purpose: l.purpose };
    let reversed = l.purpose === "REVERSAL";
    if (l.sourceType === "PAYROLL_RUN" && l.purpose === "ACCRUAL") reversed = (await db.hrPayrollRun.findUnique({ where: { id: l.sourceId }, select: { status: true } }))?.status === "CANCELLED";
    const want = await expectedLinesFor(db, ref);
    const problems = (await journalProblems(db, ref, { reversed, ...("expected" in want ? { expected: want.expected } : {}) })).filter((x) => x.code !== "DUPLICATE_UNLINKED");
    if ("problem" in want) problems.push(want.problem);
    if (problems.length) broken.push({ ...ref, problems });
  }
  const unlinkedJournals = await db.journalEntry.findMany({ where: { sourceModule: "hr", hrLinks: { none: {} } }, select: { id: true, entryNo: true, sourceDocumentId: true, status: true, totalDebit: true } });
  const has = (t: string, id: string, purpose: string) => links.some((l) => l.sourceType === t && l.sourceId === id && l.purpose === purpose);
  const runs = await db.hrPayrollRun.findMany({ where: { status: { in: ["APPROVED", "PAID", "CANCELLED"] } }, include: { payments: true, paymentReturns: true } });
  const missing: { sourceType: string; sourceId: string; purpose: string; label: string }[] = [];
  for (const r of runs) {
    const booked = has("PAYROLL_RUN", r.id, "ACCRUAL");
    if (r.status !== "CANCELLED" && !booked) missing.push({ sourceType: "PAYROLL_RUN", sourceId: r.id, purpose: "ACCRUAL", label: `run #${r.runNo} ${r.periodMonth} (${r.status}${r.accountingSkipped ? ", approved with accounting off" : ""})` });
    if (r.status === "CANCELLED" && booked && !has("PAYROLL_RUN", r.id, "REVERSAL")) missing.push({ sourceType: "PAYROLL_RUN", sourceId: r.id, purpose: "REVERSAL", label: `run #${r.runNo} ${r.periodMonth} cancelled without its reversal` });
    for (const pay of r.payments) if (!has("PAYROLL_RUN", r.id, `PAYMENT:${pay.id}`)) missing.push({ sourceType: "PAYROLL_RUN", sourceId: r.id, purpose: `PAYMENT:${pay.id}`, label: `run #${r.runNo} payment ${pay.reference}` });
    // P-2 rev3 item 2: every returned / rejected credit has its journal too.
    for (const x of r.paymentReturns) if (!has("PAYROLL_RUN", r.id, `RETURN:${x.id}`)) missing.push({ sourceType: "PAYROLL_RUN", sourceId: r.id, purpose: `RETURN:${x.id}`, label: `run #${r.runNo} ${x.kind.toLowerCase()} credit ${x.bankReference}` });
  }
  const advances = await db.hrAdvance.findMany({ where: { status: { in: ["DISBURSED", "CLOSED"] } }, include: { repayments: true } });
  for (const a of advances) {
    if (!has("ADVANCE", a.id, "DISBURSEMENT")) missing.push({ sourceType: "ADVANCE", sourceId: a.id, purpose: "DISBURSEMENT", label: `advance ${a.advanceNo}` });
    for (const rep of a.repayments) if (!has("ADVANCE_REPAYMENT", rep.id, "REPAYMENT")) missing.push({ sourceType: "ADVANCE_REPAYMENT", sourceId: rep.id, purpose: "REPAYMENT", label: `advance ${a.advanceNo} repayment ${rep.reference}` });
  }
  // Review P3-B8: final settlements and GOSI money events need their HR-linked journals too.
  const linkOf = (t: string, id: string, purpose: string) => links.find((l) => l.sourceType === t && l.sourceId === id && l.purpose === purpose);
  const settlements = await db.hrFinalSettlement.findMany({ where: { status: { in: ["POSTED", "PAID", "CLOSED"] } }, select: { id: true, settlementNo: true, status: true, journalEntryId: true, paymentJournalEntryId: true } });
  for (const s of settlements) {
    const acc = linkOf("FINAL_SETTLEMENT", s.id, "ACCRUAL");
    if (!acc || acc.journalEntryId !== s.journalEntryId) missing.push({ sourceType: "FINAL_SETTLEMENT", sourceId: s.id, purpose: "ACCRUAL", label: `final settlement ${s.settlementNo} (${s.status}) ${acc ? "names a journal that is not its HR-linked accrual" : "without its HR-linked accrual journal"}` });
    if (s.status !== "POSTED") {
      const pay = linkOf("FINAL_SETTLEMENT", s.id, "PAYMENT");
      if (!pay || pay.journalEntryId !== s.paymentJournalEntryId) missing.push({ sourceType: "FINAL_SETTLEMENT", sourceId: s.id, purpose: "PAYMENT", label: `final settlement ${s.settlementNo} (${s.status}) ${pay ? "names a payment journal that is not its HR-linked one" : "without its HR-linked payment journal"}` });
    }
  }
  // P-2 rev3 item 3: every BOOKED GOSI difference (any treatment case) has its journal.
  const gosiAdj = await db.hrGosiAdjustment.findMany({ where: { action: { in: ["EMPLOYER_EXPENSE", "EMPLOYEE_RECEIVABLE", "EMPLOYEE_REFUND"] } }, select: { settlementId: true, periodMonth: true, journalEntryId: true, treatmentCase: true } });
  for (const g of gosiAdj) {
    const l = linkOf("GOSI_SETTLEMENT", g.settlementId, "ADJUSTMENT");
    if (!l || l.journalEntryId !== g.journalEntryId) missing.push({ sourceType: "GOSI_SETTLEMENT", sourceId: g.settlementId, purpose: "ADJUSTMENT", label: `GOSI ${g.periodMonth} booked difference${g.treatmentCase ? ` (${g.treatmentCase})` : ""} without its HR-linked journal` });
  }
  // P-2 rev3 item 3: each recorded GOSI payment has its own journal PAYMENT:<id>; a PAID invoice
  // without payment rows keeps the single-payment rule (PAYMENT).
  const gosiPays = await db.hrGosiInvoicePayment.findMany({ select: { id: true, invoiceId: true, bankReference: true } });
  for (const p of gosiPays) if (!linkOf("GOSI_INVOICE", p.invoiceId, `PAYMENT:${p.id}`)) missing.push({ sourceType: "GOSI_INVOICE", sourceId: p.invoiceId, purpose: `PAYMENT:${p.id}`, label: `GOSI payment ${p.bankReference} without its HR-linked journal` });
  const gosiPaid = await db.hrGosiInvoice.findMany({ where: { stage: { in: ["PAID", "CLOSED"] } }, select: { id: true, reference: true, periodMonth: true, paymentJournalEntryId: true } });
  for (const g of gosiPaid) {
    const own = gosiPays.filter((p) => p.invoiceId === g.id);
    const ok = own.length ? own.some((p) => linkOf("GOSI_INVOICE", g.id, `PAYMENT:${p.id}`)?.journalEntryId === g.paymentJournalEntryId) : linkOf("GOSI_INVOICE", g.id, "PAYMENT")?.journalEntryId === g.paymentJournalEntryId;
    if (!ok) missing.push({ sourceType: "GOSI_INVOICE", sourceId: g.id, purpose: "PAYMENT", label: `GOSI invoice ${g.reference} (${g.periodMonth}) paid without its HR-linked payment journal` });
  }
  return {
    ok: broken.length === 0 && unlinkedJournals.length === 0 && missing.length === 0,
    checkedLinks: links.length,
    broken,
    unlinkedJournals: unlinkedJournals.map((j) => ({ entryNo: j.entryNo, sourceDocumentId: j.sourceDocumentId, status: j.status, amount: j.totalDebit.toFixed(2) })),
    missing,
  };
}
