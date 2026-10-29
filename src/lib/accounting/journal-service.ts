import { opsRefuse } from "./ops/refusals";
import { Prisma } from "@/generated/prisma/client";
import type { JournalEntryStatus } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { AccountingError } from "./errors";
import {
  assertDebitEqualsCredit,
  assertLineExclusive,
  assertPeriodOpen,
  assertSetupComplete,
  assertTaxCategoryActive,
} from "./validation";
import { buildTaxCategorySnapshot } from "./tax-snapshot";
import { isPayrollLive, payrollAccountIds, payrollLockedRefusal } from "@/lib/hr/payroll-lock";
import { assertManualJournalsEnabled } from "./manual-journals";
import { sodDecision, sodPolicy } from "./sod";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";
import { toBusinessDay, riyadhDay, parseBusinessDay } from "./dates";
import { roundMoney, toDecimal, MoneyError } from "./money";
import { checkDimensions, checkLineAccount, loadAccounts, PARTY_TYPES, ITEM_TYPES, type PartyType, type ItemType, type NormalLine } from "./posting-engine";

/**
 * MANUAL journals (the generic ledger): draft → submit → approve → post, and reversal.
 *
 * Phase 1 payroll lock (owner A-7 / A-8; independent review F1): while live payroll is off, no
 * journal touching a PAYROLL ACCOUNT (the HR posting map, PAYROLL_CASH excepted) and no journal of
 * the HR module is created, submitted, approved, posted or reversed here — for every account,
 * administrators included (409 PAYROLL_LOCKED). Ordinary journals are untouched. The database
 * refuses the posting too (hr_payroll_lock_guard on JournalEntry / JournalEntryLine).
 *
 * Accounting core A1 (20261102090000):
 *   • lines carry dimensions (branch, cost centre, party, item) and are checked like an engine posting
 *     (active postable leaf accounts, AR / AP by party, dimensions exist); CONTROL accounts (AR, AP, inventory,
 *     VAT …: allowManualJournal = false) are refused — their sub-ledgers feed them through the engine;
 *   • while accounting is activated, a manual journal is never dated before the go-live date;
 *   • SEGREGATION OF DUTIES: the approver is not the preparer (who created or submitted the entry), and the poster
 *     is not the approver — each unless the SoD setting allows it (A5, ./sod.ts; SIMPLE MODE always does). A
 *     self-approval is recorded on the entry (sodBypass); both are listed in the SoD exceptions report;
 *   • a draft is editable and deletable; a submitted / approved entry can be rejected back to draft with a reason;
 *   • a reversal marks the original REVERSED (after the reversal exists — the database insists);
 *   • every write runs with the audit context (who, IP, device, reason): the database writes the audit log.
 */
/** The HR module, however its name is cased or padded (the database compares lower(btrim(…)) too). */
const isHrModule = (sourceModule: string | null) => (sourceModule ?? "").trim().toLowerCase() === "hr";

async function assertNotPayrollJournal(tx: Prisma.TransactionClient, accountIds: string[], sourceModule: string | null) {
  if (await isPayrollLive(tx)) return;
  if (isHrModule(sourceModule) || (await payrollAccountIds(tx, accountIds)).length) {
    const r = payrollLockedRefusal("GL_PAYROLL_JOURNAL");
    throw new AccountingError(r.errorEn, 409, r.code, r.message);
  }
}

export type ManualJournalLineInput = {
  accountId: string;
  debit: number | string;
  credit: number | string;
  description?: string;
  taxCategoryId?: string;
  branchId?: string | null;
  costCenterId?: string | null;
  partyType?: string | null;
  partyId?: string | null;
  itemType?: string | null;
  itemId?: string | null;
};

export type CreateManualJournalEntryInput = {
  entryDate: Date;
  description?: string;
  lines: ManualJournalLineInput[];
  attachments?: { name: string; url: string }[] | null;
};

type CleanLine = Omit<ManualJournalLineInput, "debit" | "credit"> & { debit: Prisma.Decimal; credit: Prisma.Decimal; dims: NormalLine["dims"] };

const opt = (v: unknown, max = 64) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function cleanLines(lines: ManualJournalLineInput[]): CleanLine[] {
  if (!lines || lines.length < 2) {
    throw new AccountingError("A journal entry needs at least two lines.", 400);
  }
  const out = lines.map((l, i) => {
    let debit: Prisma.Decimal, credit: Prisma.Decimal;
    try {
      debit = roundMoney(toDecimal(typeof l.debit === "number" && !Number.isInteger(l.debit) ? String(l.debit) : l.debit ?? "0"));
      credit = roundMoney(toDecimal(typeof l.credit === "number" && !Number.isInteger(l.credit) ? String(l.credit) : l.credit ?? "0"));
    } catch (e) {
      if (e instanceof MoneyError) throw refuse("AMOUNT", `Line ${i + 1}: ${e.message}`);
      throw e;
    }
    const partyType = opt(l.partyType, 20);
    const itemType = opt(l.itemType, 20);
    if (partyType && !(PARTY_TYPES as readonly string[]).includes(partyType)) throw refuse("BAD_INPUT", `Line ${i + 1}: partyType.`);
    if (itemType && !(ITEM_TYPES as readonly string[]).includes(itemType)) throw refuse("BAD_INPUT", `Line ${i + 1}: itemType.`);
    const partyId = opt(l.partyId), itemId = opt(l.itemId);
    if (!!partyType !== !!partyId || !!itemType !== !!itemId) throw refuse("BAD_INPUT", `Line ${i + 1}: a dimension's type and id go together.`);
    return { ...l, debit, credit, dims: { branchId: opt(l.branchId), costCenterId: opt(l.costCenterId), partyType: partyType as PartyType | null, partyId, itemType: itemType as ItemType | null, itemId } };
  });
  for (const line of out) assertLineExclusive(line);
  assertDebitEqualsCredit(out);
  return out;
}

function cleanAttachments(a: unknown): Prisma.InputJsonValue | undefined {
  if (a === undefined || a === null) return undefined;
  if (!Array.isArray(a) || a.length > 20) throw refuse("BAD_INPUT", "attachments: at most 20 { name, url }.");
  return a.map((x) => {
    const name = opt((x as { name?: unknown })?.name, 200), url = opt((x as { url?: unknown })?.url, 1000);
    if (!name || !url || !/^https:\/\//.test(url)) throw refuse("BAD_INPUT", "attachments: { name, url (https) }.");
    return { name, url };
  });
}

/** Lines validated against the chart (postable, not control, AR / AP party, dimensions) and the period / go-live. */
async function validateLines(tx: Prisma.TransactionClient, entryDate: Date, lines: CleanLine[]) {
  const period = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: entryDate }, endDate: { gte: entryDate } } });
  if (!period) throw new AccountingError("No fiscal period covers this entry date.", 400);
  assertPeriodOpen(period);
  const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } });
  if (s?.accountingActive && s.goLiveDate && entryDate < s.goLiveDate) throw refuse("BEFORE_GO_LIVE");
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  await assertNotPayrollJournal(tx, accountIds, "manual");
  const accounts = await loadAccounts(tx, accountIds);
  if (accounts.size !== accountIds.length) throw new AccountingError("One or more accounts were not found.", 400);
  for (const l of lines) checkLineAccount(accounts.get(l.accountId), l, { manual: true });
  await checkDimensions(tx, lines);
  const taxCategoryIds = [...new Set(lines.map((l) => l.taxCategoryId).filter((id): id is string => !!id))];
  const taxCategories = taxCategoryIds.length ? await tx.taxCategory.findMany({ where: { id: { in: taxCategoryIds } } }) : [];
  const taxCategoryById = new Map(taxCategories.map((t) => [t.id, t]));
  for (const line of lines) {
    if (line.taxCategoryId) {
      const taxCategory = taxCategoryById.get(line.taxCategoryId);
      if (!taxCategory) throw new AccountingError("Tax category not found.", 400);
      assertTaxCategoryActive(taxCategory);
      // SA4: a purchase VAT code (P-*) is for supplier invoices only — never a manual journal line.
      if (taxCategory.appliesTo === "PURCHASES") throw opsRefuse("TAX_CATEGORY_PURCHASES_ONLY");
    }
  }
  return { period, taxCategoryById };
}

const lineData = (lines: CleanLine[], tax: Map<string, Parameters<typeof buildTaxCategorySnapshot>[0]>) =>
  lines.map((l, i) => ({
    lineNo: i + 1,
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
    description: l.description,
    taxCategorySnapshot: l.taxCategoryId ? buildTaxCategorySnapshot(tax.get(l.taxCategoryId)!) : undefined,
    branchId: l.dims.branchId, costCenterId: l.dims.costCenterId, partyType: l.dims.partyType, partyId: l.dims.partyId, itemType: l.dims.itemType, itemId: l.dims.itemId,
  }));

const ctxOf = (who: string | AuditContext): AuditContext => (typeof who === "string" ? { actorId: who } : who);

export async function createManualJournalEntry(input: CreateManualJournalEntryInput, who: string | AuditContext) {
  const ctx = ctxOf(who);
  // Phase 1 (owner decision D1): manual journals are disabled for everyone (./manual-journals).
  await assertManualJournalsEnabled();
  await assertSetupComplete();
  const lines = cleanLines(input.lines);
  const entryDate = toBusinessDay(input.entryDate);
  const attachments = cleanAttachments(input.attachments);

  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await assertManualJournalsEnabled(tx);
    return insertManualDraft(tx, entryDate, input.description, lines, attachments, ctx.actorId);
  }, TX_OPTS);
}

async function insertManualDraft(tx: Prisma.TransactionClient, entryDate: Date, description: string | undefined, lines: CleanLine[], attachments: Prisma.InputJsonValue | undefined, createdBy: string, source?: { type: string; id: string; event: string }) {
  await assertManualJournalsEnabled(tx);
  const { period, taxCategoryById } = await validateLines(tx, entryDate, lines);
  const total = lines.reduce((sum, l) => sum.add(l.debit), new Prisma.Decimal(0));
  return tx.journalEntry.create({
    data: {
      entryDate,
      fiscalPeriodId: period.id,
      type: "MANUAL",
      status: "DRAFT",
      sourceModule: "manual",
      ...(source ? { sourceType: source.type, sourceId: source.id, sourceEvent: source.event, sourceDocumentId: source.id } : {}),
      description,
      totalDebit: total,
      totalCredit: total,
      createdBy,
      attachments,
      lines: { create: lineData(lines, taxCategoryById) },
    },
    include: { lines: true },
  });
}

/**
 * «المعاملات المتكررة»: the same manual-journal DRAFT, inside the CALLER'S transaction (the recurring run commits its run
 * row and its draft together). Every rule of createManualJournalEntry applies: manual journals enabled, setup complete,
 * ≥ 2 lines, balanced, open period, after go-live, no payroll account, no control account, dimensions exist. The draft
 * names its source (sourceType / sourceId / sourceEvent) and its preparer (`createdBy`); the caller sets the audit context.
 */
export async function createManualJournalDraftIn(tx: Prisma.TransactionClient, input: CreateManualJournalEntryInput, createdBy: string, source: { type: string; id: string; event: string }) {
  await assertManualJournalsEnabled(tx);
  const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { setupComplete: true } });
  if (!s?.setupComplete) throw new AccountingError("Accounting setup is not complete. Complete accounting settings before posting.", 409);
  return insertManualDraft(tx, toBusinessDay(input.entryDate), input.description, cleanLines(input.lines), undefined, createdBy, source);
}

/**
 * «المعاملات المتكررة» with auto-post: the same manual journal (createManualJournalDraftIn — every check of the manual
 * path: manual journals enabled, setup complete, balanced, open period, after go-live, no payroll / control account, tax
 * categories, dimensions), then submitted by its preparer and approved and POSTED by the person who authorised the
 * standing journal, in the caller's transaction. It stays type MANUAL, so the manual-journal review, the SoD exceptions
 * and the auditor's filters see it; `sodBypass` records that the authorisation was the preparer's own (SoD setting).
 * The database numbers it gaplessly and checks its balance at commit, as for any posting.
 */
export async function postRecurringJournalIn(tx: Prisma.TransactionClient, input: CreateManualJournalEntryInput, who: { preparer: string; poster: string; sodBypass: boolean }, source: { type: string; id: string; event: string }) {
  const draft = await createManualJournalDraftIn(tx, input, who.preparer, source);
  const now = new Date();
  return tx.journalEntry.update({
    where: { id: draft.id },
    data: { status: "POSTED", submittedAt: now, submittedBy: who.preparer, approvedAt: now, approvedBy: who.poster, postedAt: now, postedBy: who.poster, sodBypass: who.sodBypass },
  });
}

/** Row-lock the entry for the rest of the transaction: a concurrent approve / reject / post / edit of the
 *  same entry waits, then reads the committed status (READ COMMITTED: every later statement sees it). */
async function lockEntry(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "JournalEntry" WHERE "id" = ${id} FOR UPDATE`;
}

/** Replace a DRAFT's date, description, lines and attachments. */
export async function updateManualJournalDraft(id: string, input: CreateManualJournalEntryInput, who: string | AuditContext) {
  const ctx = ctxOf(who);
  await assertManualJournalsEnabled();
  const lines = cleanLines(input.lines);
  const entryDate = toBusinessDay(input.entryDate);
  const attachments = cleanAttachments(input.attachments);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await lockEntry(tx, id);
    await assertManualJournalsEnabled(tx);
    const entry = await tx.journalEntry.findUnique({ where: { id }, select: { status: true, type: true } });
    if (!entry) throw refuse("NOT_FOUND");
    if (entry.status !== "DRAFT" || entry.type !== "MANUAL") throw refuse("DRAFT_ONLY");
    const { period, taxCategoryById } = await validateLines(tx, entryDate, lines);
    const total = lines.reduce((sum, l) => sum.add(l.debit), new Prisma.Decimal(0));
    await tx.journalEntryLine.deleteMany({ where: { journalEntryId: id } });
    return tx.journalEntry.update({
      where: { id },
      data: {
        entryDate, fiscalPeriodId: period.id, description: input.description, totalDebit: total, totalCredit: total,
        attachments: attachments ?? Prisma.DbNull, rejectedAt: null, rejectedBy: null, rejectReason: null,
        lines: { create: lineData(lines, taxCategoryById) },
      },
      include: { lines: true },
    });
  }, TX_OPTS);
}

export async function deleteManualJournalDraft(id: string, who: string | AuditContext) {
  const ctx = ctxOf(who);
  await assertManualJournalsEnabled();
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await assertManualJournalsEnabled(tx);
    await lockEntry(tx, id);
    const entry = await tx.journalEntry.findUnique({ where: { id }, select: { status: true, type: true } });
    if (!entry) throw refuse("NOT_FOUND");
    if (entry.status !== "DRAFT" || entry.type !== "MANUAL") throw refuse("DRAFT_ONLY");
    await tx.journalEntry.delete({ where: { id } });
    return { id, deleted: true };
  }, TX_OPTS);
}

async function transitionStatus(
  id: string,
  from: JournalEntryStatus[],
  to: JournalEntryStatus,
  stamp: (entry: { createdBy: string | null; submittedBy: string | null }) => Record<string, unknown>,
  ctx: AuditContext,
) {
  await assertManualJournalsEnabled();
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await lockEntry(tx, id);
    await assertManualJournalsEnabled(tx);
    const entry = await tx.journalEntry.findUnique({ where: { id } });
    if (!entry) throw new AccountingError("Journal entry not found.", 404);
    if (!from.includes(entry.status)) {
      throw new AccountingError(`Cannot transition from ${entry.status} to ${to}.`, 409);
    }
    const lines = await tx.journalEntryLine.findMany({ where: { journalEntryId: id }, select: { accountId: true } });
    await assertNotPayrollJournal(tx, lines.map((l) => l.accountId), entry.sourceModule);
    return tx.journalEntry.update({ where: { id }, data: { status: to, ...stamp(entry) } });
  }, TX_OPTS);
}

export async function submitJournalEntry(id: string, who: string | AuditContext) {
  const ctx = ctxOf(who);
  return transitionStatus(id, ["DRAFT"], "SUBMITTED", () => ({ submittedAt: new Date(), submittedBy: ctx.actorId }), ctx);
}

/** Four-eyes: the approver is neither the creator nor the submitter — unless the SoD setting allows self-approval
 *  (A5, src/lib/accounting/sod.ts; SIMPLE MODE always does). An allowed self-approval is recorded (sodBypass). */
export async function approveJournalEntry(id: string, who: string | AuditContext) {
  const ctx = ctxOf(who);
  const policy = await sodPolicy();
  return transitionStatus(id, ["SUBMITTED"], "APPROVED", (entry) => {
    const self = entry.createdBy === ctx.actorId || entry.submittedBy === ctx.actorId;
    if (self && !sodDecision(policy, "SELF_APPROVAL")) throw refuse("SOD_SELF_APPROVAL");
    return { approvedAt: new Date(), approvedBy: ctx.actorId, sodBypass: self };
  }, ctx);
}

/** SUBMITTED / APPROVED → DRAFT, with a reason (the preparer edits and submits again). */
export async function rejectJournalEntry(id: string, reason: unknown, who: string | AuditContext) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3) throw refuse("REASON_REQUIRED");
  const ctx = { ...ctxOf(who), reason: why };
  return transitionStatus(id, ["SUBMITTED", "APPROVED"], "DRAFT", () => ({
    rejectedAt: new Date(), rejectedBy: ctx.actorId, rejectReason: why.slice(0, 500),
    submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, sodBypass: false,
  }), ctx);
}

export async function postJournalEntry(id: string, who: string | AuditContext) {
  const ctx = ctxOf(who);
  await assertManualJournalsEnabled();
  await assertSetupComplete();
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await lockEntry(tx, id);
    await assertManualJournalsEnabled(tx);
    const entry = await tx.journalEntry.findUnique({
      where: { id },
      include: { lines: true, fiscalPeriod: true },
    });
    if (!entry) throw new AccountingError("Journal entry not found.", 404);
    if (entry.status !== "APPROVED") {
      throw new AccountingError(`Only Approved entries can be posted (current status: ${entry.status}).`, 409);
    }
    // A5 SoD setting (b): the approver posts only if «يجوز للمعتمِد الترحيل» is on (SIMPLE MODE: always). Listed in
    // the SoD exceptions report either way (approvedBy = postedBy).
    if (entry.approvedBy === ctx.actorId && !sodDecision(await sodPolicy(tx), "APPROVER_POSTS")) throw refuse("SOD_APPROVER_POSTS");
    assertPeriodOpen(entry.fiscalPeriod);
    assertDebitEqualsCredit(entry.lines);
    await assertNotPayrollJournal(tx, entry.lines.map((l) => l.accountId), entry.sourceModule);
    return tx.journalEntry.update({
      where: { id },
      data: { status: "POSTED", postedAt: new Date(), postedBy: ctx.actorId },
    });
  }, TX_OPTS);
}

// Reversal requires explicit permission (enforced at the route level) and a mandatory
// reason. The reversal entry posts immediately on creation rather than going through its
// own Draft -> Submit -> Approve cycle: the reversal action is already gated as a sensitive
// operation by the route guard. The original is then marked REVERSED (A1: the database accepts
// that only once the reversal exists).
export async function reverseJournalEntry(id: string, who: string | AuditContext, reason: string, date?: string | null) {
  const ctx = ctxOf(who);
  await assertManualJournalsEnabled();
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    throw new AccountingError("A reason is required to reverse a journal entry.", 400);
  }

  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: trimmedReason });
    await lockEntry(tx, id);
    await assertManualJournalsEnabled(tx);
    const original = await tx.journalEntry.findUnique({
      where: { id },
      include: { lines: true, reversedByEntry: true },
    });
    if (!original) throw new AccountingError("Journal entry not found.", 404);
    if (original.status !== "POSTED") {
      throw new AccountingError("Only Posted journal entries can be reversed.", 409);
    }
    if (original.reversedByEntry) {
      throw new AccountingError("This journal entry has already been reversed.", 409);
    }
    if (original.type === "REVERSAL") throw refuse("REVERSAL_OF_REVERSAL"); // audit F-10
    // A journal of the HR module is reversed only through HR (its linked reversal; the database
    // refuses anything else) — a refusal, never a 500 (independent review F7). While payroll is
    // locked it is PAYROLL_LOCKED, as is any journal on a payroll account.
    await assertNotPayrollJournal(tx, original.lines.map((l) => l.accountId), original.sourceModule);
    if (isHrModule(original.sourceModule)) {
      throw new AccountingError("A journal posted by HR is reversed only through HR.", 409, "HR_JOURNAL", "قيد الموارد البشرية لا يُعكس إلا من خلال الموارد البشرية.");
    }
    // An engine entry is reversed through the posting engine (POST /api/accounting/journals/:id/reverse routes it).
    if (original.idempotencyKey) throw refuse("NOT_ENGINE_ENTRY", "Reverse it through the posting engine.");

    // The reversal posts on the given business day (default: today, Asia/Riyadh), never retroactively
    // into the original's period (which may since have been Locked or Closed).
    let day: Date;
    try { day = date ? parseBusinessDay(date) : riyadhDay(); } catch { throw refuse("BAD_INPUT", "date is YYYY-MM-DD."); }
    const reversalPeriod = await tx.fiscalPeriod.findFirst({
      where: { startDate: { lte: day }, endDate: { gte: day } },
    });
    if (day < original.entryDate) throw refuse("REVERSAL_BEFORE_ORIGINAL");
    if (!reversalPeriod) throw refuse("PERIOD_MISSING");
    assertPeriodOpen(reversalPeriod);

    const now = new Date();
    const rev = await tx.journalEntry.create({
      data: {
        entryDate: day,
        fiscalPeriodId: reversalPeriod.id,
        type: "REVERSAL",
        status: "POSTED",
        sourceModule: original.sourceModule,
        sourceDocumentId: original.sourceDocumentId,
        reversesEntryId: original.id,
        description: (() => { const ref = original.postingYear && original.postingSeq ? `JE-${original.postingYear}-${String(original.postingSeq).padStart(6, "0")}` : `#${original.entryNo}`; return `عكس القيد ${ref}: ${trimmedReason}`.slice(0, 500); })(),
        reversalReason: trimmedReason,
        totalDebit: original.totalCredit,
        totalCredit: original.totalDebit,
        createdBy: ctx.actorId,
        postedAt: now,
        postedBy: ctx.actorId,
        lines: {
          create: original.lines.map((l, i) => ({
            lineNo: i + 1,
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            description: l.description ? `عكس: ${l.description}`.slice(0, 500) : "عكس",
            taxCategorySnapshot: l.taxCategorySnapshot ?? undefined,
            branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId, itemType: l.itemType, itemId: l.itemId,
          })),
        },
      },
      include: { lines: true },
    });
    await tx.journalEntry.update({ where: { id: original.id }, data: { status: "REVERSED", reversedAt: now, reversedBy: ctx.actorId } });
    return rev;
  }, TX_OPTS);
}
