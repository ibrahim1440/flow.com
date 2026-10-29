// Accounting A5 — segregation of duties as a SETTING (owner request: one accountant today, more later).
//
// One policy for the three places that had their own SIMPLE MODE bypass:
//   (a) self-approval — A1 manual journal approved by its preparer / submitter; A2 credit / debit note issued by its
//       preparer; A3 supplier invoice posted by its preparer, last editor or submitter (approve = post);
//   (b) the approver may post — A1 manual journal posted by the person who approved it.
// Effective rule: SIMPLE MODE (one owner, src/lib/simple-mode.ts) allows both whatever the setting says; otherwise
// AccountingSettings.sodAllowSelfApproval / sodApproverMayPost decide (both default true: allowed, flagged). Every
// use is recorded on the document (JournalEntry.sodBypass, SalesInvoice.sodBypass; for the AP invoice and the
// approver-posted journal the people on the document already show it) and listed by sodExceptions() for the auditor.
// Fixed assets (20261121090000): activation by the asset's preparer and an addition / disposal entered and posted in one
// act are the same self-approval (refused, or allowed and flagged — JournalEntry.sodBypass, FA_SELF_POSTED).
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal } from "./money";
import { isSimpleMode } from "@/lib/simple-mode";
import { dayText } from "./dates";
import { postingRef } from "./posting-engine";
import { setAuditContext, type AuditContext } from "./audit";

type Db = Prisma.TransactionClient | typeof prisma;

export type SodPolicy = {
  allowSelfApproval: boolean;
  approverMayPost: boolean;
  /** The stored settings (what the screen edits). */
  stored: { allowSelfApproval: boolean; approverMayPost: boolean };
  simpleMode: boolean;
};

/** Read every time (no cache). A missing row reads as the defaults (true, true). */
export async function sodPolicy(db: Db = prisma): Promise<SodPolicy> {
  const s = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { sodAllowSelfApproval: true, sodApproverMayPost: true } });
  const stored = { allowSelfApproval: s?.sodAllowSelfApproval ?? true, approverMayPost: s?.sodApproverMayPost ?? true };
  const simpleMode = isSimpleMode();
  return { stored, simpleMode, allowSelfApproval: simpleMode || stored.allowSelfApproval, approverMayPost: simpleMode || stored.approverMayPost };
}

/** Pure: the decision for one act. */
export function sodDecision(policy: Pick<SodPolicy, "allowSelfApproval" | "approverMayPost">, act: "SELF_APPROVAL" | "APPROVER_POSTS"): boolean {
  return act === "SELF_APPROVAL" ? policy.allowSelfApproval : policy.approverMayPost;
}

/** «فصل المهام» (accounting › settings_manage + step-up at the route): audited by the database (AccountingSettings). */
export async function setSodPolicy(input: { allowSelfApproval?: unknown; approverMayPost?: unknown }, ctx: AuditContext) {
  const data: { sodAllowSelfApproval?: boolean; sodApproverMayPost?: boolean; updatedBy: string } = { updatedBy: ctx.actorId };
  if (input.allowSelfApproval !== undefined) {
    if (typeof input.allowSelfApproval !== "boolean") throw new TypeError("allowSelfApproval");
    data.sodAllowSelfApproval = input.allowSelfApproval;
  }
  if (input.approverMayPost !== undefined) {
    if (typeof input.approverMayPost !== "boolean") throw new TypeError("approverMayPost");
    data.sodApproverMayPost = input.approverMayPost;
  }
  await prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.accountingSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
  });
  return sodPolicy();
}

/** The fixed-asset postings the setting applies to (their engine source types). */
export const FA_SOD_SOURCES = ["FIXED_ASSET", "FA_ADDITION", "FA_DISPOSAL"] as const;
const FA_SOD_SOURCES_DETAIL: Record<(typeof FA_SOD_SOURCES)[number], string> = { FIXED_ASSET: "asset activated by its preparer", FA_ADDITION: "addition entered and posted by one person", FA_DISPOSAL: "disposal entered and posted by one person" };

export type SodException = {
  kind: "JOURNAL_SELF_APPROVED" | "JOURNAL_APPROVER_POSTED" | "NOTE_SELF_ISSUED" | "AP_SELF_POSTED" | "FA_SELF_POSTED" | "PERIOD_REOPENED" | "RECURRING_SELF_AUTHORISED" | "STANDING_SELF_AUTHORISED" | "BUDGET_SELF_APPROVED" | "RECEIPT_SELF_CONFIRMED";
  at: string; day: string; ref: string; amount: string | null; actorId: string | null; detail: string; href: string;
};

/**
 * «استثناءات فصل المهام» — every act where one person held two duties the policy normally separates, plus every
 * reopen of a closed period and every budget approved by its preparer, between two days (by the day of the act). Read straight from the documents: nothing to
 * keep in step, nothing a user can edit (posted journals, issued notes and posted invoices are immutable).
 */
export async function sodExceptions(from: Date, to: Date): Promise<{ from: string; to: string; rows: SodException[]; counts: Record<string, number> }> {
  const end = new Date(to.getTime() + 86_400_000 - 1 + 3 * 3600_000);
  const start = new Date(from.getTime() - 3 * 3600_000);
  const [journals, notes, ap, reopens, standing, fa, budgets, receipts] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { type: { in: ["MANUAL", "ADJUSTMENT"] }, approvedAt: { gte: start, lte: end }, OR: [{ sodBypass: true }, { status: { in: ["POSTED", "REVERSED"] } }] },
      select: { id: true, entryNo: true, postingYear: true, postingSeq: true, entryDate: true, sodBypass: true, createdBy: true, submittedBy: true, approvedBy: true, approvedAt: true, postedBy: true, postedAt: true, totalDebit: true, status: true, sourceType: true },
      orderBy: { approvedAt: "asc" },
    }),
    prisma.salesInvoice.findMany({ where: { sodBypass: true, issuedAt: { gte: start, lte: end } }, select: { id: true, number: true, kind: true, issuedAt: true, issuedById: true, createdById: true, grandTotal: true }, orderBy: { issuedAt: "asc" } }),
    prisma.supplierInvoice.findMany({ where: { status: { in: ["POSTED", "CANCELLED"] }, postedAt: { gte: start, lte: end } }, select: { id: true, number: true, postedAt: true, postedBy: true, createdBy: true, lastEditedBy: true, submittedBy: true, grossTotal: true }, orderBy: { postedAt: "asc" } }),
    prisma.fiscalPeriod.findMany({ where: { reopenedAt: { gte: start, lte: end } }, select: { id: true, year: true, periodNo: true, reopenedAt: true, reopenedBy: true, reopenReason: true, reopenCount: true } }),
    // «التفويض الدائم» (20261124090000_standing_authorisation): a self-authorisation the SoD setting allowed — a recurring
    // journal's auto-post authorised by its own preparer (RECURRING_SELF_AUTHORISED), or a register-wide scheduler run
    // (deferral recognition, depreciation) authorised by a preparer of the register's live items (STANDING_SELF_AUTHORISED).
    // Read from the authorisations themselves, so one revoked since is still listed.
    prisma.standingAuthorisation.findMany({ where: { sodBypass: true, authorisedAt: { gte: start, lte: end } }, select: { id: true, register: true, scopeId: true, authorisedAt: true, authorisedBy: true, revokedAt: true } }),
    // «الأصول الثابتة»: an asset activated by its preparer, an addition / disposal entered and posted by one person —
    // allowed by the setting, flagged on the engine entry (FA_SOD: src/lib/accounting/fixed-assets/common.ts faSod).
    prisma.journalEntry.findMany({ where: { sourceModule: "accounting", sourceType: { in: [...FA_SOD_SOURCES] }, sodBypass: true, postedAt: { gte: start, lte: end } }, select: { id: true, entryNo: true, postingYear: true, postingSeq: true, sourceType: true, postedAt: true, postedBy: true, totalDebit: true }, orderBy: { postedAt: "asc" } }),
    // «الموازنات» (council F5): a budget approved by its preparer (creator or last editor). Deferrals have no approval step:
    // a run is posted by journal_post holders and reversed by journal_reverse holders (step-up), like any engine entry.
    prisma.glBudget.findMany({ where: { sodBypass: true, approvedAt: { gte: start, lte: end } }, select: { id: true, name: true, fiscalYear: true, revisionNo: true, approvedAt: true, approvedBy: true, createdBy: true } }),
    // «سند قبض» (BATCH22 WP-D): a receipt for an invoice with no deal confirmed by the accountant who recorded it (the
    // setting allowed it; SalesCollection_four_eyes_check requires the flag).
    prisma.salesCollection.findMany({ where: { sodBypass: true, decidedAt: { gte: start, lte: end } }, select: { id: true, receiptNumber: true, decidedAt: true, decidedById: true, amountGross: true } }),
  ]);
  const rows: SodException[] = [];
  const day = (d: Date) => dayText(new Date(d.getTime() + 3 * 3600_000));
  for (const j of journals) {
    const ref = postingRef(j) ?? `#${j.entryNo}`;
    if (j.sodBypass && j.approvedAt) rows.push({ kind: "JOURNAL_SELF_APPROVED", at: j.approvedAt.toISOString(), day: day(j.approvedAt), ref, amount: j.totalDebit.toFixed(2), actorId: j.approvedBy, detail: j.createdBy === j.approvedBy ? "preparer approved" : "submitter approved", href: `/dashboard/accounting/journals/${j.id}` });
    if (j.postedBy && j.approvedBy && j.postedBy === j.approvedBy && j.postedAt) rows.push({ kind: "JOURNAL_APPROVER_POSTED", at: j.postedAt.toISOString(), day: day(j.postedAt), ref, amount: j.totalDebit.toFixed(2), actorId: j.postedBy, detail: `${j.createdBy === j.postedBy ? "prepared, approved and posted by one person" : "approver posted"}${j.sourceType === "RECURRING" ? " (recurring auto-post)" : ""}`, href: `/dashboard/accounting/journals/${j.id}` });
  }
  for (const n of notes) rows.push({ kind: "NOTE_SELF_ISSUED", at: n.issuedAt!.toISOString(), day: day(n.issuedAt!), ref: n.number ?? n.id, amount: n.grandTotal.toFixed(2), actorId: n.issuedById, detail: n.kind, href: `/dashboard/sales/invoices/${n.id}` });
  for (const a of ap) {
    if (!a.postedBy || ![a.createdBy, a.lastEditedBy, a.submittedBy].includes(a.postedBy)) continue;
    rows.push({ kind: "AP_SELF_POSTED", at: a.postedAt!.toISOString(), day: day(a.postedAt!), ref: a.number, amount: a.grossTotal.toFixed(2), actorId: a.postedBy, detail: a.postedBy === a.createdBy ? "preparer posted" : a.postedBy === a.submittedBy ? "submitter posted" : "last editor posted", href: `/dashboard/purchases/invoices/${a.id}` });
  }
  for (const f of fa) rows.push({ kind: "FA_SELF_POSTED", at: f.postedAt!.toISOString(), day: day(f.postedAt!), ref: postingRef(f) ?? `#${f.entryNo}`, amount: f.totalDebit.toFixed(2), actorId: f.postedBy, detail: FA_SOD_SOURCES_DETAIL[f.sourceType as (typeof FA_SOD_SOURCES)[number]] ?? String(f.sourceType), href: `/dashboard/accounting/journals/${f.id}` });
  for (const p of reopens) rows.push({ kind: "PERIOD_REOPENED", at: p.reopenedAt!.toISOString(), day: day(p.reopenedAt!), ref: `${p.year}-${String(p.periodNo).padStart(2, "0")}`, amount: null, actorId: p.reopenedBy, detail: `#${p.reopenCount}: ${p.reopenReason ?? ""}`, href: "/dashboard/accounting/periods" });
  const scopes = standing.map((r) => r.scopeId).filter((x): x is string => !!x);
  const schedules = new Map((scopes.length ? await prisma.recurringSchedule.findMany({ where: { id: { in: scopes } }, select: { id: true, refNo: true, name: true, payload: true } }) : []).map((x) => [x.id, x]));
  for (const r of standing) {
    const revoked = r.revokedAt ? " (revoked since)" : "";
    if (r.register === "RECURRING_AUTOPOST") {
      const sc = r.scopeId ? schedules.get(r.scopeId) : undefined;
      const lines = ((sc?.payload as { lines?: { debit?: string }[] } | null)?.lines ?? []);
      const amount = lines.reduce((t, l) => t.plus(l.debit ?? "0"), new Decimal(0));
      rows.push({ kind: "RECURRING_SELF_AUTHORISED", at: r.authorisedAt.toISOString(), day: day(r.authorisedAt), ref: sc ? `REC-${String(sc.refNo).padStart(6, "0")}` : r.id, amount: amount.toFixed(2), actorId: r.authorisedBy, detail: `the preparer authorised auto-post: ${sc?.name ?? ""}${revoked}`.slice(0, 200), href: `/dashboard/accounting/recurring/${r.scopeId}` });
    } else {
      const deferrals = r.register === "DEFERRAL_RECOGNITION";
      rows.push({ kind: "STANDING_SELF_AUTHORISED", at: r.authorisedAt.toISOString(), day: day(r.authorisedAt), ref: deferrals ? "DEFERRAL_RECOGNITION" : "DEPRECIATION", amount: null, actorId: r.authorisedBy, detail: `a preparer of the register's live items authorised the scheduler to post: ${deferrals ? "deferral recognition" : "depreciation"}${revoked}`.slice(0, 200), href: deferrals ? "/dashboard/accounting/deferrals" : "/dashboard/accounting/fixed-assets/depreciation" });
    }
  }
  for (const g of budgets) rows.push({ kind: "BUDGET_SELF_APPROVED", at: g.approvedAt!.toISOString(), day: day(g.approvedAt!), ref: `${g.name} ${g.fiscalYear} r${g.revisionNo}`, amount: null, actorId: g.approvedBy, detail: g.approvedBy === g.createdBy ? "preparer approved" : "last editor approved", href: `/dashboard/accounting/budgets/${g.id}` });
  for (const c of receipts) rows.push({ kind: "RECEIPT_SELF_CONFIRMED", at: c.decidedAt!.toISOString(), day: day(c.decidedAt!), ref: c.receiptNumber ?? c.id, amount: c.amountGross.toFixed(2), actorId: c.decidedById, detail: "receipt recorded and confirmed by one person", href: `/dashboard/accounting/receipts?id=${c.id}` });
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return { from: dayText(from), to: dayText(to), rows, counts };
}
