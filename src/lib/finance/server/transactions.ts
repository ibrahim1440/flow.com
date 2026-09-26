// Bank and cash lines: manual entry, CSV import, review/classification, document matching,
// transfers between company accounts, voiding, attachments.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { fromMinor, parseMoney, toMinor, type Minor } from "../money";
import { addDays, dbDate, isDateString, riyadhDateString } from "../dates";
import { fileHash, fingerprintRows, mapRows, parseCsv, type CsvMapping } from "../csv";
import { ALL_CLASSES, classDirection, isAllocatableClass, SETTLEMENT_CLASSES, type TxnClass } from "../classes";
import {
  assertCan, assertScope, audit, COMPANY, FinanceError, reqStr, scopeWhere, str,
  type Db, type FinanceActor, type FinanceScope,
} from "./context";
import { recomputeObligationStatus } from "./obligations";
import { reversePaymentsForTxn, reverseReceiptAllocations, runAllocation } from "./allocation";
import { receiptUnallocated } from "./ledger";

// ─── Accounts ─────────────────────────────────────────────────────────────────

export async function createAccount(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "settings_manage");
  const branchKey = str(body.branchKey, 60) ?? COMPANY;
  assertScope(scope, branchKey);
  const type = String(body.type ?? "BANK");
  if (!["BANK", "CASH", "GATEWAY_CLEARING"].includes(type)) throw new FinanceError("Unknown account type.", 400);
  const last4 = str(body.accountLast4, 4);
  if (last4 && !/^\d{4}$/.test(last4)) throw new FinanceError("Enter only the last four digits of the account number.", 400);
  const opening = body.openingBalance === undefined || body.openingBalance === "" ? 0 : parseMoney(body.openingBalance);
  if (opening === null) throw new FinanceError("Invalid opening balance.", 400);
  if (!isDateString(body.openingBalanceDate)) throw new FinanceError("Opening balance date is required (YYYY-MM-DD).", 400);
  if (body.currency !== undefined && body.currency !== "SAR") {
    throw new FinanceError("Only SAR accounts are supported: amounts in different currencies are never aggregated without a conversion policy.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const a = await tx.cashAccount.create({
      data: {
        code: reqStr(body.code, "Code", 30).toUpperCase(), nameEn: reqStr(body.nameEn, "English name", 120), nameAr: str(body.nameAr, 120),
        type: type as "BANK", branchKey, bankName: str(body.bankName, 120), accountLast4: last4, isRestricted: body.isRestricted === true,
        openingBalance: fromMinor(opening), openingBalanceDate: dbDate(body.openingBalanceDate as string), glAccountId: str(body.glAccountId, 40),
        createdBy: actor.id,
      },
    });
    await audit(tx, { action: "cash_account.created", entityType: "CashAccount", entityId: a.id, branchKey, after: a, userId: actor.id });
    return a;
  });
}

async function accountInScope(db: Db, scope: FinanceScope, id: string) {
  const a = await db.cashAccount.findUnique({ where: { id } });
  if (!a) throw new FinanceError("Account not found.", 404);
  assertScope(scope, a.branchKey);
  if (!a.active) throw new FinanceError("Account is inactive.", 409);
  return a;
}

// ─── Manual entry ─────────────────────────────────────────────────────────────

function parseSettlement(body: Record<string, unknown>, amount: Minor) {
  if (body.grossAmount === undefined && body.feeAmount === undefined) return { gross: null, fee: null };
  const gross = parseMoney(body.grossAmount);
  const fee = parseMoney(body.feeAmount);
  if (gross === null || fee === null || fee < 0) throw new FinanceError("Enter gross proceeds and a non-negative fee.", 400);
  if (gross - fee !== amount) throw new FinanceError(`Gross (${fromMinor(gross)}) − fee (${fromMinor(fee)}) must equal the net deposit (${fromMinor(amount)}).`, 400);
  return { gross, fee };
}

export async function createManualTransaction(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "txn_enter");
  const account = await accountInScope(prisma, scope, reqStr(body.cashAccountId, "Account", 40));
  const amount = parseMoney(body.amount);
  if (amount === null || amount === 0) throw new FinanceError("Amount must be a non-zero SAR amount with at most two decimals (negative for money out).", 400);
  if (!isDateString(body.txnDate)) throw new FinanceError("Date is required (YYYY-MM-DD).", 400);
  const status = body.status === "PENDING" ? "PENDING" : "CONFIRMED";
  if (status === "CONFIRMED" && (body.txnDate as string) > riyadhDateString()) throw new FinanceError("A future-dated line can only be recorded as pending.", 400);
  const { gross, fee } = parseSettlement(body, amount);
  const idempotencyKey = str(body.idempotencyKey, 100);
  const reference = str(body.bankReference, 120);

  if (idempotencyKey) {
    const prior = await prisma.bankTransaction.findUnique({ where: { createdBy_idempotencyKey: { createdBy: actor.id, idempotencyKey } } });
    if (prior) return { replayed: true, transaction: prior };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // Same account + same bank reference is suspicious, never automatically a duplicate.
      const sameRef = reference
        ? await tx.bankTransaction.findFirst({ where: { cashAccountId: account.id, bankReference: reference, status: { not: "VOID" } }, select: { id: true } })
        : null;
      const t = await tx.bankTransaction.create({
        data: {
          cashAccountId: account.id, branchKey: account.branchKey, txnDate: dbDate(body.txnDate as string), amount: fromMinor(amount),
          grossAmount: gross === null ? null : fromMinor(gross), feeAmount: fee === null ? null : fromMinor(fee),
          bankReference: reference, description: str(body.description, 500), counterparty: str(body.counterparty, 200),
          status, source: "MANUAL", idempotencyKey, possibleDuplicateOfId: sameRef?.id ?? null, createdBy: actor.id,
        },
      });
      await audit(tx, { action: "bank_txn.created", entityType: "BankTransaction", entityId: t.id, branchKey: t.branchKey, after: t, userId: actor.id });
      return { replayed: false, transaction: t };
    });
  } catch (err) {
    if (idempotencyKey && (err as { code?: string })?.code === "P2002") {
      const prior = await prisma.bankTransaction.findUnique({ where: { createdBy_idempotencyKey: { createdBy: actor.id, idempotencyKey } } });
      if (prior) return { replayed: true, transaction: prior };
    }
    throw err;
  }
}

// ─── CSV import ───────────────────────────────────────────────────────────────

function parseMapping(raw: unknown): CsvMapping {
  const m = (raw ?? {}) as Record<string, unknown>;
  const fmt = String(m.dateFormat ?? "YYYY-MM-DD");
  if (!["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"].includes(fmt)) throw new FinanceError("Unknown date format.", 400);
  const s = (k: string) => (typeof m[k] === "string" && (m[k] as string).trim() ? (m[k] as string).trim() : undefined);
  const date = s("date");
  if (!date) throw new FinanceError("Map the date column.", 400);
  return {
    date, amount: s("amount"), debit: s("debit"), credit: s("credit"), reference: s("reference"),
    description: s("description"), counterparty: s("counterparty"), account: s("account"),
    dateFormat: fmt as CsvMapping["dateFormat"], hasHeader: m.hasHeader !== false,
  };
}

type ImportRowResult = {
  rowNo: number; txnDate: string; amount: Minor; reference: string | null; description: string | null;
  accountId: string; accountCode: string; fingerprint: string;
  status: "NEW" | "DUPLICATE" | "FLAGGED" | "EXISTING" | "SETTLES"; flaggedReason?: string; possibleDuplicateOfId?: string;
  /** EXISTING: the already-recorded line this statement row confirms (no new line is created).
   *  SETTLES: the same statement row was imported earlier as PENDING; this settled copy
   *  confirms that line (same fingerprint — never a second line). */
  existingId?: string;
};

/**
 * A statement row is the SAME money as a line somebody already recorded (a payment made
 * outside the application and entered by hand, or a receipt entered on arrival) when:
 *   same account, same signed amount, the recorded line is not void and has never been
 *   confirmed by a statement (no fingerprint), and either both carry the same bank reference
 *   or, when a reference is missing, the statement date falls from 3 days before to 7 days
 *   after the recorded date (bank posting lag).
 * Exactly one candidate: the row confirms that line (EXISTING). Several: FLAGGED for a
 * person to choose (resolveDuplicate). Never auto-rejected, never auto-duplicated.
 */
const STATEMENT_WINDOW = { before: 3, after: 7 };
const normRef = (r: string | null | undefined) => (r ?? "").trim().toUpperCase();

async function analyseImport(db: Db, scope: FinanceScope, body: Record<string, unknown>) {
  const text = typeof body.csv === "string" ? body.csv : "";
  if (!text.trim()) throw new FinanceError("The file is empty.", 400);
  if (text.length > 5_000_000) throw new FinanceError("File too large (5 MB maximum).", 413);
  const defaultAccount = await accountInScope(db, scope, reqStr(body.cashAccountId, "Account", 40));
  const mapping = parseMapping(body.mapping);
  const rows = parseCsv(text);
  if (rows.length > 20_001) throw new FinanceError("At most 20 000 rows per import.", 413);
  const { parsed, errors, header } = mapRows(rows, mapping);

  // Resolve per-row accounts when an account column is mapped.
  const scopedAccounts = await db.cashAccount.findMany({ where: { active: true, ...scopeWhere(scope) } });
  const byRef = new Map<string, typeof defaultAccount>();
  for (const a of scopedAccounts) { byRef.set(a.code.toUpperCase(), a); if (a.accountLast4) byRef.set(a.accountLast4, a); }
  const withAccount: (typeof parsed[number] & { account: typeof defaultAccount })[] = [];
  for (const p of parsed) {
    if (mapping.account) {
      const a = p.accountRef ? byRef.get(p.accountRef.toUpperCase()) ?? byRef.get(p.accountRef.slice(-4)) : undefined;
      if (!a) { errors.push({ rowNo: p.rowNo, field: "account", message: "Account not recognised or not in your branches", raw: p.accountRef ?? "" }); continue; }
      withAccount.push({ ...p, account: a });
    } else withAccount.push({ ...p, account: defaultAccount });
  }

  // Fingerprint per account, in file order.
  const results: ImportRowResult[] = [];
  const groups = new Map<string, typeof withAccount>();
  for (const r of withAccount) groups.set(r.account.id, [...(groups.get(r.account.id) ?? []), r]);
  for (const [accountId, list] of groups) {
    const fps = fingerprintRows(accountId, list);
    const existing = await db.bankTransaction.findMany({ where: { cashAccountId: accountId, sourceFingerprint: { in: fps } }, select: { id: true, status: true, sourceFingerprint: true } });
    const known = new Map(existing.map((e) => [e.sourceFingerprint, e]));
    const settling = body.importAsPending !== true;
    const today = riyadhDateString();
    const dates = [...new Set(list.map((l) => l.txnDate))].map(dbDate);
    const sameDay = await db.bankTransaction.findMany({
      where: { cashAccountId: accountId, txnDate: { in: dates }, status: { not: "VOID" } },
      select: { id: true, txnDate: true, amount: true, sourceFingerprint: true, bankReference: true },
    });
    const minD = list.reduce((m, l) => (l.txnDate < m ? l.txnDate : m), list[0].txnDate);
    const maxD = list.reduce((m, l) => (l.txnDate > m ? l.txnDate : m), list[0].txnDate);
    const recorded = await db.bankTransaction.findMany({
      where: { cashAccountId: accountId, sourceFingerprint: null, status: { not: "VOID" }, txnDate: { gte: dbDate(addDays(minD, -STATEMENT_WINDOW.after)), lte: dbDate(addDays(maxD, STATEMENT_WINDOW.before)) } },
      select: { id: true, txnDate: true, amount: true, bankReference: true },
    });
    const claimed = new Set<string>();
    list.forEach((r, i) => {
      const base = {
        rowNo: r.rowNo, txnDate: r.txnDate, amount: r.amount, reference: r.reference, description: r.description,
        accountId, accountCode: r.account.code, fingerprint: fps[i],
      };
      const k = known.get(fps[i]);
      if (k) {
        // Seen before. A pending line whose settled row now arrives is confirmed, not duplicated.
        if (k.status === "PENDING" && settling && r.txnDate <= today) results.push({ ...base, status: "SETTLES", existingId: k.id });
        else results.push({ ...base, status: "DUPLICATE" });
        return;
      }
      const sameMoney = recorded.filter((x) => !claimed.has(x.id) && toMinor(x.amount) === r.amount);
      const byRef = r.reference ? sameMoney.filter((x) => normRef(x.bankReference) === normRef(r.reference)) : [];
      const inWindow = sameMoney.filter((x) => {
        if (x.bankReference && r.reference && normRef(x.bankReference) !== normRef(r.reference)) return false;
        const d = x.txnDate.toISOString().slice(0, 10);
        return r.txnDate >= addDays(d, -STATEMENT_WINDOW.before) && r.txnDate <= addDays(d, STATEMENT_WINDOW.after);
      });
      const pick = byRef.length > 0 ? byRef : inWindow;
      if (pick.length === 1) { claimed.add(pick[0].id); results.push({ ...base, status: "EXISTING", existingId: pick[0].id }); return; }
      if (pick.length > 1) { results.push({ ...base, status: "FLAGGED", possibleDuplicateOfId: pick[0].id, flaggedReason: "Several recorded lines could be this statement line; choose one" }); return; }
      const clash = sameDay.find((s) => s.txnDate.toISOString().slice(0, 10) === r.txnDate && toMinor(s.amount) === r.amount && s.sourceFingerprint !== fps[i]);
      const refClash = r.reference ? sameDay.find((s) => s.bankReference && s.bankReference === r.reference) : undefined;
      if (clash || refClash) {
        results.push({ ...base, status: "FLAGGED", possibleDuplicateOfId: (refClash ?? clash)!.id, flaggedReason: refClash ? "Same bank reference as an existing line" : "Same date and amount as an existing line (may be legitimate)" });
      } else results.push({ ...base, status: "NEW" });
    });
  }
  results.sort((a, b) => a.rowNo - b.rowNo);
  return { text, mapping, header, results, errors, defaultAccount, rowCount: rows.length - (mapping.hasHeader ? 1 : 0) };
}

export async function previewImport(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "txn_enter");
  const a = await analyseImport(prisma, scope, body);
  const count = (s: string) => a.results.filter((r) => r.status === s).length;
  return {
    header: a.header, rowCount: a.rowCount,
    summary: { new: count("NEW"), duplicate: count("DUPLICATE"), flagged: count("FLAGGED"), existing: count("EXISTING") + count("SETTLES"), errors: a.errors.length },
    rows: a.results.slice(0, 500), errors: a.errors.slice(0, 500),
  };
}

export async function commitImport(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "txn_enter");
  const fileName = str(body.fileName, 200) ?? "statement.csv";
  const asPending = body.importAsPending === true;
  return prisma.$transaction(async (tx) => {
    const a = await analyseImport(tx, scope, body);
    if (a.errors.some((e) => e.rowNo === 0)) throw new FinanceError("Fix the column mapping first.", 400, a.errors);
    const today = riyadhDateString();
    const toInsert = a.results.filter((r) => r.status === "NEW" || r.status === "FLAGGED");
    const toAttach = a.results.filter((r) => r.status === "EXISTING");
    const toSettle = a.results.filter((r) => r.status === "SETTLES");
    const batch = await tx.bankImportBatch.create({
      data: {
        cashAccountId: a.defaultAccount.id, fileName, fileHash: fileHash(a.text), mapping: a.mapping as unknown as Prisma.InputJsonValue,
        rowCount: a.rowCount, importedCount: 0, duplicateCount: a.results.length - toInsert.length, flaggedCount: 0,
        errorCount: a.errors.length, errors: a.errors as unknown as Prisma.InputJsonValue, createdBy: actor.id,
      },
    });
    // Statement rows that confirm an already-recorded line: no new cash line is created.
    let attached = 0;
    for (const r of toAttach) {
      const before = await tx.bankTransaction.findUniqueOrThrow({ where: { id: r.existingId! } });
      const confirm = !asPending && r.txnDate <= today;
      const res = await tx.bankTransaction.updateMany({
        where: { id: r.existingId!, sourceFingerprint: null, status: { not: "VOID" } },
        data: {
          sourceFingerprint: r.fingerprint, statementBatchId: batch.id, statementConfirmedAt: new Date(),
          bankReference: before.bankReference ?? r.reference,
          ...(confirm && before.status === "PENDING" ? { status: "CONFIRMED" as const } : {}),
          ...(before.reconciliationId ? {} : { txnDate: dbDate(r.txnDate) }),
        },
      });
      if (res.count === 1) {
        attached++;
        const after = await tx.bankTransaction.findUniqueOrThrow({ where: { id: r.existingId! } });
        await audit(tx, { action: "bank_txn.statement_confirmed", entityType: "BankTransaction", entityId: after.id, branchKey: after.branchKey, before: { status: before.status, txnDate: before.txnDate, bankReference: before.bankReference }, after: { status: after.status, txnDate: after.txnDate, bankReference: after.bankReference }, refs: { importBatchId: batch.id, rowNo: r.rowNo }, userId: actor.id });
      } else {
        // Lost a race with another import or a merge: land it as a flagged new line instead.
        toInsert.push({ ...r, status: "FLAGGED", possibleDuplicateOfId: r.existingId, flaggedReason: "The recorded line was confirmed by another statement meanwhile" });
      }
    }
    // Pending lines whose settled statement row has arrived: confirmed in place.
    for (const r of toSettle) {
      const res = await tx.bankTransaction.updateMany({
        where: { id: r.existingId!, status: "PENDING" },
        data: { status: "CONFIRMED", statementBatchId: batch.id, statementConfirmedAt: new Date() },
      });
      if (res.count === 1) {
        attached++;
        const after = await tx.bankTransaction.findUniqueOrThrow({ where: { id: r.existingId! } });
        await audit(tx, { action: "bank_txn.settled", entityType: "BankTransaction", entityId: after.id, branchKey: after.branchKey, before: { status: "PENDING" }, after: { status: after.status }, refs: { importBatchId: batch.id, rowNo: r.rowNo }, userId: actor.id });
      }
    }
    const accountBranch = new Map<string, string>();
    for (const r of toInsert) {
      if (!accountBranch.has(r.accountId)) accountBranch.set(r.accountId, (await tx.cashAccount.findUniqueOrThrow({ where: { id: r.accountId } })).branchKey);
    }
    // skipDuplicates rides the (cashAccountId, sourceFingerprint) unique index, so two
    // people importing the same statement at the same moment still land each line once.
    const inserted = await tx.bankTransaction.createMany({
      skipDuplicates: true,
      data: toInsert.map((r) => ({
        cashAccountId: r.accountId, branchKey: accountBranch.get(r.accountId)!, txnDate: dbDate(r.txnDate), amount: fromMinor(r.amount),
        bankReference: r.reference, description: r.description, status: asPending || r.txnDate > today ? ("PENDING" as const) : ("CONFIRMED" as const),
        source: "CSV_IMPORT" as const, sourceFingerprint: r.fingerprint, possibleDuplicateOfId: r.possibleDuplicateOfId ?? null,
        reviewNote: r.flaggedReason ?? null, importBatchId: batch.id, createdBy: actor.id,
      })),
    });
    const flagged = await tx.bankTransaction.count({ where: { importBatchId: batch.id, possibleDuplicateOfId: { not: null } } });
    const upd = await tx.bankImportBatch.update({
      where: { id: batch.id },
      data: { importedCount: inserted.count, attachedCount: attached, duplicateCount: a.results.length - inserted.count - attached, flaggedCount: flagged },
    });
    await audit(tx, { action: "bank_import.committed", entityType: "BankImportBatch", entityId: batch.id, branchKey: a.defaultAccount.branchKey, after: upd, userId: actor.id });
    return upd;
  }, { timeout: 60_000 });
}

// ─── Listing and detail ───────────────────────────────────────────────────────

export async function listTransactions(db: Db, scope: FinanceScope, q: URLSearchParams) {
  const where: Prisma.BankTransactionWhereInput = { ...scopeWhere(scope) };
  if (q.get("accountId")) where.cashAccountId = q.get("accountId")!;
  if (q.get("status")) where.status = q.get("status") as "PENDING";
  if (q.get("review")) where.reviewStatus = q.get("review") as "NEEDS_REVIEW";
  if (q.get("classification")) where.classification = q.get("classification") as "UNCLASSIFIED";
  if (q.get("from") || q.get("to")) {
    where.txnDate = {
      ...(isDateString(q.get("from")) ? { gte: dbDate(q.get("from")!) } : {}),
      ...(isDateString(q.get("to")) ? { lte: dbDate(q.get("to")!) } : {}),
    };
  }
  if (q.get("q")) {
    const s = q.get("q")!.slice(0, 100);
    where.OR = [{ description: { contains: s, mode: "insensitive" } }, { bankReference: { contains: s, mode: "insensitive" } }, { counterparty: { contains: s, mode: "insensitive" } }];
  }
  if (q.get("finCategoryId")) where.splits = { some: { finCategoryId: q.get("finCategoryId")! } };
  const take = Math.min(Number(q.get("take") ?? 50) || 50, 200);
  const skip = Math.max(Number(q.get("skip") ?? 0) || 0, 0);
  const [rows, total] = await Promise.all([
    db.bankTransaction.findMany({
      where, orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }], take, skip,
      include: { cashAccount: { select: { code: true, nameEn: true, nameAr: true } }, splits: true, _count: { select: { matches: { where: { active: true } } } } },
    }),
    db.bankTransaction.count({ where }),
  ]);
  return { rows, total, take, skip };
}

export async function getTransaction(db: Db, scope: FinanceScope, id: string) {
  const t = await db.bankTransaction.findUnique({
    where: { id },
    include: { cashAccount: true, splits: true, matches: { orderBy: { createdAt: "asc" } }, importBatch: { select: { id: true, fileName: true, createdAt: true } } },
  });
  if (!t) throw new FinanceError("Not found", 404);
  assertScope(scope, t.branchKey);
  const [entries, attachments, run, audits, peer, dup] = await Promise.all([
    db.allocationEntry.findMany({ where: { sourceTxnId: id }, include: { category: { select: { code: true, nameEn: true, nameAr: true } } }, orderBy: { createdAt: "asc" } }),
    db.finAttachment.findMany({ where: { entityType: "BankTransaction", entityId: id }, select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, createdBy: true } }),
    db.allocationRun.findUnique({ where: { sourceTxnId: id } }),
    db.finAuditLog.findMany({ where: { entityType: "BankTransaction", entityId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
    t.transferPeerId ? db.bankTransaction.findUnique({ where: { id: t.transferPeerId }, select: { id: true, cashAccountId: true, amount: true, txnDate: true } }) : null,
    t.possibleDuplicateOfId ? db.bankTransaction.findUnique({ where: { id: t.possibleDuplicateOfId }, select: { id: true, txnDate: true, amount: true, bankReference: true, description: true } }) : null,
  ]);
  const unallocated = toMinor(t.amount) > 0 && t.status === "CONFIRMED" ? await receiptUnallocated(db, id, toMinor(t.amount)) : 0;
  const reviewerIds = [...new Set([t.createdBy, t.reviewedBy, ...audits.map((a) => a.userId)].filter(Boolean) as string[])];
  const people = await db.employee.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } });
  return { transaction: t, entries, attachments, run, audits, peer, possibleDuplicate: dup, unallocated, people };
}

// ─── Review / classification ──────────────────────────────────────────────────

type SplitInput = { finCategoryId: string; amount: Minor; costCenterId: string | null; note: string | null };

function parseSplits(raw: unknown): SplitInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FinanceError("splits must be an array.", 400);
  if (raw.length > 50) throw new FinanceError("At most 50 splits.", 400);
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const amount = parseMoney(o.amount);
    if (amount === null || amount === 0) throw new FinanceError(`Split ${i + 1}: invalid amount.`, 400);
    return { finCategoryId: reqStr(o.finCategoryId, `Split ${i + 1} category`, 40), amount, costCenterId: str(o.costCenterId, 40), note: str(o.note, 300) };
  });
}

export async function reviewTransaction(actor: FinanceActor, scope: FinanceScope, id: string, body: Record<string, unknown>) {
  assertCan(actor, "txn_enter");
  const classification = String(body.classification ?? "") as TxnClass;
  if (!(ALL_CLASSES as readonly string[]).includes(classification)) throw new FinanceError("Unknown classification.", 400);
  const splits = parseSplits(body.splits);
  const markReviewed = body.markReviewed !== false;
  const reverseAllocations = body.reverseAllocations === true;

  const result = await prisma.$transaction(async (tx) => {
    const t = await tx.bankTransaction.findUnique({ where: { id }, include: { splits: true } });
    if (!t) throw new FinanceError("Not found", 404);
    assertScope(scope, t.branchKey);
    if (t.status === "VOID") throw new FinanceError("A void line cannot be classified.", 409);
    const amount = toMinor(t.amount);
    const dir = classDirection(classification);
    if (dir === "IN" && amount < 0) throw new FinanceError("That classification is for money received.", 400);
    if (dir === "OUT" && amount > 0) throw new FinanceError("That classification is for money paid out.", 400);

    // Settlement detail.
    let gross = t.grossAmount === null ? null : toMinor(t.grossAmount);
    let fee = t.feeAmount === null ? null : toMinor(t.feeAmount);
    if (body.grossAmount !== undefined || body.feeAmount !== undefined) {
      if (!SETTLEMENT_CLASSES.includes(classification)) throw new FinanceError("Gross and fee apply only to POS and gateway settlements.", 400);
      const s = parseSettlement(body, amount);
      gross = s.gross; fee = s.fee;
    }

    if (classification === "INTERNAL_TRANSFER" && splits.length > 0) throw new FinanceError("A transfer between company accounts has no budget category.", 400);
    if (markReviewed) {
      if (classification === "UNCLASSIFIED") throw new FinanceError("Choose a classification before marking the line reviewed.", 400);
      if (classification !== "INTERNAL_TRANSFER") {
        const sum = splits.reduce((s, x) => s + x.amount, 0);
        if (splits.length === 0 || sum !== amount) {
          throw new FinanceError(`Budget splits must add up to the line amount exactly (${fromMinor(sum)} of ${fromMinor(amount)}).`, 400);
        }
      }
    }
    const cats = await tx.finCategory.findMany({ where: { id: { in: splits.map((s) => s.finCategoryId) } } });
    for (const s of splits) {
      const c = cats.find((x) => x.id === s.finCategoryId);
      if (!c || !c.active) throw new FinanceError("A split names an unknown or inactive budget category.", 400);
    }

    // Allocations already made from this receipt?
    const allocated = amount > 0 && t.status === "CONFIRMED" ? amount - (await receiptUnallocated(tx, id, amount)) : 0;
    let reversal = null;
    if (allocated > 0 && !isAllocatableClass(classification)) {
      if (!reverseAllocations) {
        throw new FinanceError(`${fromMinor(allocated)} SAR of this receipt has already been allocated. Confirm reversing those allocations to reclassify it.`, 409, { allocated });
      }
      reversal = await reverseReceiptAllocations(tx, actor.id, id, `Reclassified to ${classification}: ${str(body.note, 300) ?? "no note"}`);
    }

    await tx.bankTransactionSplit.deleteMany({ where: { transactionId: id } });
    if (splits.length) {
      await tx.bankTransactionSplit.createMany({
        data: splits.map((s) => ({ transactionId: id, finCategoryId: s.finCategoryId, costCenterId: s.costCenterId, amount: fromMinor(s.amount), note: s.note })),
      });
    }
    const after = await tx.bankTransaction.update({
      where: { id },
      data: {
        classification,
        grossAmount: gross === null ? null : fromMinor(gross), feeAmount: fee === null ? null : fromMinor(fee),
        reviewStatus: markReviewed ? "REVIEWED" : "NEEDS_REVIEW",
        reviewNote: str(body.note, 500) ?? t.reviewNote,
        reviewedBy: markReviewed ? actor.id : t.reviewedBy, reviewedAt: markReviewed ? new Date() : t.reviewedAt,
        // A reviewer who keeps a flagged line has decided it is not a duplicate.
        possibleDuplicateOfId: markReviewed ? null : t.possibleDuplicateOfId,
      },
      include: { splits: true },
    });
    await audit(tx, {
      action: "bank_txn.reviewed", entityType: "BankTransaction", entityId: id, branchKey: t.branchKey,
      before: { classification: t.classification, reviewStatus: t.reviewStatus, splits: t.splits, gross: t.grossAmount, fee: t.feeAmount },
      after: { classification: after.classification, reviewStatus: after.reviewStatus, splits: after.splits, gross: after.grossAmount, fee: after.feeAmount },
      reason: str(body.note, 300), refs: reversal ? { reversal } : undefined, userId: actor.id,
    });
    return { transaction: after, reversal };
  });

  // Automatic allocation only under an ACTIVE, approved, autoExecute policy — and still
  // idempotent (one run per receipt), so a second review changes nothing.
  let autoRun = null;
  const t = result.transaction;
  if (t.reviewStatus === "REVIEWED" && t.status === "CONFIRMED" && toMinor(t.amount) > 0 && isAllocatableClass(t.classification as TxnClass)) {
    const v = await prisma.allocationRuleVersion.findFirst({ where: { branchKey: t.branchKey, status: "ACTIVE", autoExecute: true } });
    if (v && v.baseClasses.includes(t.classification)) {
      try { autoRun = await runAllocation(actor, scope, t.id, "AUTO"); }
      catch (e) { autoRun = { error: e instanceof Error ? e.message : "Automatic allocation failed" }; }
    }
  }
  return { ...result, autoRun };
}

export async function confirmPending(actor: FinanceActor, scope: FinanceScope, id: string) {
  assertCan(actor, "txn_enter");
  return prisma.$transaction(async (tx) => {
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw new FinanceError("Not found", 404);
    assertScope(scope, t.branchKey);
    if (t.status !== "PENDING") throw new FinanceError("Only a pending line can be confirmed.", 409);
    if (t.txnDate.toISOString().slice(0, 10) > riyadhDateString()) throw new FinanceError("A future-dated line cannot be confirmed yet.", 409);
    const after = await tx.bankTransaction.update({ where: { id }, data: { status: "CONFIRMED" } });
    await audit(tx, { action: "bank_txn.confirmed", entityType: "BankTransaction", entityId: id, branchKey: t.branchKey, before: { status: t.status }, after: { status: "CONFIRMED" }, userId: actor.id });
    return after;
  });
}

export async function voidTransaction(actor: FinanceActor, scope: FinanceScope, id: string, reason: string) {
  assertCan(actor, "txn_enter");
  return prisma.$transaction(async (tx) => {
    const t = await tx.bankTransaction.findUnique({ where: { id } });
    if (!t) throw new FinanceError("Not found", 404);
    assertScope(scope, t.branchKey);
    if (t.status === "VOID") return { transaction: t, reversal: null };
    if (t.reconciliationId) throw new FinanceError("This line is part of a completed reconciliation. Record a correcting line instead.", 409);
    const ids = [t.id, ...(t.transferPeerId ? [t.transferPeerId] : [])];
    let reversal = null;
    for (const lineId of ids) {
      const line = await tx.bankTransaction.findUniqueOrThrow({ where: { id: lineId } });
      if (line.reconciliationId) throw new FinanceError("The other leg of this transfer is reconciled.", 409);
      if (toMinor(line.amount) > 0) reversal = await reverseReceiptAllocations(tx, actor.id, lineId, `Receipt voided: ${reason}`);
      else await reversePaymentsForTxn(tx, actor.id, lineId, `Payment voided: ${reason}`);
      const matches = await tx.bankTransactionMatch.findMany({ where: { transactionId: lineId, active: true } });
      await tx.bankTransactionMatch.updateMany({ where: { transactionId: lineId, active: true }, data: { active: false, removedAt: new Date(), removedBy: actor.id } });
      await tx.bankTransaction.update({ where: { id: lineId }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actor.id, voidReason: reason } });
      for (const m of matches.filter((x) => x.targetType === "OBLIGATION")) await recomputeObligationStatus(tx, m.targetId);
      await audit(tx, { action: "bank_txn.voided", entityType: "BankTransaction", entityId: lineId, branchKey: line.branchKey, before: { status: line.status }, after: { status: "VOID" }, reason, refs: reversal ? { reversal } : undefined, userId: actor.id });
    }
    return { transaction: await tx.bankTransaction.findUniqueOrThrow({ where: { id } }), reversal };
  });
}

/**
 * A reviewer decides that an imported statement line is the same money as a line already
 * recorded: the imported line is voided (so the money never counts twice) and its statement
 * identity moves to the recorded line, so re-importing the statement stays a no-op.
 */
export async function resolveDuplicate(actor: FinanceActor, scope: FinanceScope, importedId: string, keepId: string) {
  assertCan(actor, "txn_enter");
  if (importedId === keepId) throw new FinanceError("Choose two different lines.", 400);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id IN (${importedId}, ${keepId}) ORDER BY id FOR UPDATE`;
    const [imp, keep] = await Promise.all([tx.bankTransaction.findUnique({ where: { id: importedId } }), tx.bankTransaction.findUnique({ where: { id: keepId } })]);
    if (!imp || !keep) throw new FinanceError("Not found", 404);
    assertScope(scope, imp.branchKey);
    if (imp.cashAccountId !== keep.cashAccountId || toMinor(imp.amount) !== toMinor(keep.amount)) throw new FinanceError("Only lines of the same account and amount can be the same money.", 400);
    if (imp.source !== "CSV_IMPORT" || !imp.sourceFingerprint) throw new FinanceError("The line to drop must be an imported statement line.", 400);
    if (keep.sourceFingerprint) throw new FinanceError("The recorded line is already confirmed by a statement.", 409);
    if (imp.status === "VOID" || keep.status === "VOID") throw new FinanceError("A void line cannot be merged.", 409);
    if (imp.reconciliationId) throw new FinanceError("The imported line is reconciled; record a correcting line instead.", 409);
    const [entries, matches] = await Promise.all([
      tx.allocationEntry.count({ where: { sourceTxnId: imp.id } }),
      tx.bankTransactionMatch.count({ where: { transactionId: imp.id, active: true } }),
    ]);
    if (entries + matches > 0) throw new FinanceError("The imported line is already allocated or matched; undo that first.", 409);
    const today = riyadhDateString();
    const statementDate = imp.txnDate.toISOString().slice(0, 10);
    await tx.bankTransaction.update({ where: { id: imp.id }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actor.id, voidReason: `Same money as recorded line ${keep.id}`, sourceFingerprint: null } });
    const after = await tx.bankTransaction.update({
      where: { id: keep.id },
      data: {
        sourceFingerprint: imp.sourceFingerprint, statementBatchId: imp.importBatchId, statementConfirmedAt: new Date(),
        bankReference: keep.bankReference ?? imp.bankReference,
        ...(keep.status === "PENDING" && statementDate <= today ? { status: "CONFIRMED" as const } : {}),
        ...(keep.reconciliationId ? {} : { txnDate: imp.txnDate }),
      },
    });
    await audit(tx, { action: "bank_txn.duplicate_resolved", entityType: "BankTransaction", entityId: keep.id, branchKey: keep.branchKey, before: { keep: { status: keep.status }, imported: { id: imp.id, status: imp.status } }, after: { keep: { status: after.status }, imported: { id: imp.id, status: "VOID" } }, userId: actor.id });
    return after;
  });
}

// ─── Transfers between company accounts ───────────────────────────────────────

export async function createTransfer(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "txn_enter");
  const from = await accountInScope(prisma, scope, reqStr(body.fromAccountId, "From account", 40));
  const to = await accountInScope(prisma, scope, reqStr(body.toAccountId, "To account", 40));
  if (from.id === to.id) throw new FinanceError("Choose two different accounts.", 400);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
  if (!isDateString(body.txnDate)) throw new FinanceError("Date is required.", 400);
  const status: "PENDING" | "CONFIRMED" = body.status === "PENDING" ? "PENDING" : "CONFIRMED";
  const reference = str(body.bankReference, 120);
  return prisma.$transaction(async (tx) => {
    const common = { txnDate: dbDate(body.txnDate as string), bankReference: reference, description: str(body.description, 500) ?? `Transfer ${from.code} → ${to.code}`, status, source: "MANUAL" as const, classification: "INTERNAL_TRANSFER" as const, reviewStatus: "REVIEWED" as const, reviewedBy: actor.id, reviewedAt: new Date(), createdBy: actor.id };
    const out = await tx.bankTransaction.create({ data: { ...common, cashAccountId: from.id, branchKey: from.branchKey, amount: fromMinor(-amount) } });
    const inn = await tx.bankTransaction.create({ data: { ...common, cashAccountId: to.id, branchKey: to.branchKey, amount: fromMinor(amount), transferPeerId: out.id } });
    await tx.bankTransaction.update({ where: { id: out.id }, data: { transferPeerId: inn.id } });
    await audit(tx, { action: "bank_txn.transfer", entityType: "BankTransaction", entityId: out.id, branchKey: from.branchKey, after: { out: out.id, in: inn.id, amount }, userId: actor.id });
    return { out, in: inn };
  });
}

/** Pair two existing (e.g. imported) lines as the two legs of one transfer. */
export async function linkTransfer(actor: FinanceActor, scope: FinanceScope, idA: string, idB: string) {
  assertCan(actor, "txn_enter");
  return prisma.$transaction(async (tx) => {
    const [a, b] = await Promise.all([tx.bankTransaction.findUnique({ where: { id: idA } }), tx.bankTransaction.findUnique({ where: { id: idB } })]);
    if (!a || !b) throw new FinanceError("Not found", 404);
    assertScope(scope, a.branchKey); assertScope(scope, b.branchKey);
    if (a.cashAccountId === b.cashAccountId) throw new FinanceError("Transfer legs must be in different accounts.", 400);
    if (toMinor(a.amount) !== -toMinor(b.amount)) throw new FinanceError("Transfer legs must be equal and opposite.", 400);
    if (a.transferPeerId || b.transferPeerId) throw new FinanceError("One of the lines is already paired.", 409);
    for (const t of [a, b]) {
      const alloc = toMinor(t.amount) > 0 ? toMinor(t.amount) - (await receiptUnallocated(tx, t.id, toMinor(t.amount))) : 0;
      if (alloc > 0) throw new FinanceError("One of the lines has allocations; reclassify it with reversal first.", 409);
    }
    const data = { classification: "INTERNAL_TRANSFER" as const, reviewStatus: "REVIEWED" as const, reviewedBy: actor.id, reviewedAt: new Date() };
    await tx.bankTransactionSplit.deleteMany({ where: { transactionId: { in: [a.id, b.id] } } });
    await tx.bankTransaction.update({ where: { id: a.id }, data: { ...data, transferPeerId: b.id } });
    await tx.bankTransaction.update({ where: { id: b.id }, data: { ...data, transferPeerId: a.id } });
    await audit(tx, { action: "bank_txn.transfer_linked", entityType: "BankTransaction", entityId: a.id, branchKey: a.branchKey, refs: { peer: b.id }, userId: actor.id });
  });
}

// ─── Matching to ERP documents ───────────────────────────────────────────────

export async function addMatch(actor: FinanceActor, scope: FinanceScope, txnId: string, body: Record<string, unknown>) {
  assertCan(actor, "txn_enter");
  const targetType = String(body.targetType);
  if (!["ORDER", "OBLIGATION", "PURCHASE_RECORD", "SALES_COLLECTION"].includes(targetType)) throw new FinanceError("Unknown document type.", 400);
  if (targetType === "SALES_COLLECTION") {
    throw new FinanceError("Sales collections are not available on this branch yet (feature/sales-crm-commissions). Link to the order instead.", 409);
  }
  const targetId = reqStr(body.targetId, "Document", 40);
  const amount = parseMoney(body.amount);
  if (amount === null || amount <= 0) throw new FinanceError("Amount must be positive.", 400);
  const taxAmount = body.taxAmount === undefined || body.taxAmount === "" ? 0 : parseMoney(body.taxAmount);
  if (taxAmount === null || taxAmount < 0 || taxAmount > amount) throw new FinanceError("VAT must be between 0 and the matched amount.", 400);

  return prisma.$transaction(async (tx) => {
    // Row lock: two people matching the same line at once cannot over-apply it.
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${txnId} FOR UPDATE`;
    const t = await tx.bankTransaction.findUnique({ where: { id: txnId } });
    if (!t) throw new FinanceError("Not found", 404);
    assertScope(scope, t.branchKey);
    if (t.status === "VOID") throw new FinanceError("A void line cannot be matched.", 409);
    const lineAmount = toMinor(t.amount);
    if (targetType === "ORDER") {
      if (lineAmount < 0 && t.classification !== "CUSTOMER_REFUND") throw new FinanceError("Orders are matched to money received (or to customer refunds).", 400);
      const o = await tx.order.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!o) throw new FinanceError("Order not found.", 404);
    } else {
      if (lineAmount > 0) throw new FinanceError("Obligations and purchases are matched to money paid out.", 400);
      if (targetType === "OBLIGATION") {
        const o = await tx.finObligation.findUnique({ where: { id: targetId } });
        if (!o || o.branchKey !== t.branchKey) throw new FinanceError("Obligation not found in this branch.", 404);
        if (o.status === "SUPERSEDED" || o.status === "CANCELLED") throw new FinanceError("That obligation is no longer live.", 409);
      } else {
        const p = await tx.purchaseRecord.findUnique({ where: { id: targetId }, select: { id: true } });
        if (!p) throw new FinanceError("Purchase record not found.", 404);
      }
    }
    const used = await tx.bankTransactionMatch.aggregate({ where: { transactionId: txnId, active: true }, _sum: { amount: true } });
    if (amount + toMinor(used._sum.amount) > Math.abs(lineAmount)) {
      throw new FinanceError(`Only ${fromMinor(Math.abs(lineAmount) - toMinor(used._sum.amount))} SAR of this line is unmatched.`, 409);
    }
    const m = await tx.bankTransactionMatch.create({
      data: { transactionId: txnId, targetType: targetType as "ORDER", targetId, amount: fromMinor(amount), taxAmount: fromMinor(taxAmount), createdBy: actor.id },
    });
    if (targetType === "OBLIGATION") await recomputeObligationStatus(tx, targetId);
    await audit(tx, { action: "bank_txn.matched", entityType: "BankTransaction", entityId: txnId, branchKey: t.branchKey, after: m, userId: actor.id });
    return m;
  });
}

export async function removeMatch(actor: FinanceActor, scope: FinanceScope, matchId: string, reason: string) {
  assertCan(actor, "txn_enter");
  return prisma.$transaction(async (tx) => {
    const m = await tx.bankTransactionMatch.findUnique({ where: { id: matchId }, include: { transaction: true } });
    if (!m || !m.active) throw new FinanceError("Not found", 404);
    assertScope(scope, m.transaction.branchKey);
    const run = await tx.allocationRun.findUnique({ where: { sourceTxnId: m.transactionId } });
    if (run && toMinor(m.taxAmount) > 0) throw new FinanceError("This match's VAT has already been reserved by an allocation run.", 409);
    const upd = await tx.bankTransactionMatch.update({ where: { id: matchId }, data: { active: false, removedAt: new Date(), removedBy: actor.id } });
    if (m.targetType === "OBLIGATION") await recomputeObligationStatus(tx, m.targetId);
    await audit(tx, { action: "bank_txn.unmatched", entityType: "BankTransaction", entityId: m.transactionId, branchKey: m.transaction.branchKey, before: m, after: upd, reason, userId: actor.id });
    return upd;
  });
}

/** Candidate documents for matching, within reach of the caller. */
export async function matchCandidates(db: Db, scope: FinanceScope, txnId: string, q: string) {
  const t = await db.bankTransaction.findUnique({ where: { id: txnId } });
  if (!t) throw new FinanceError("Not found", 404);
  assertScope(scope, t.branchKey);
  const term = q.trim().slice(0, 60);
  if (toMinor(t.amount) > 0 || t.classification === "CUSTOMER_REFUND") {
    const num = Number(term);
    const orders = await db.order.findMany({
      where: term ? { OR: [...(Number.isInteger(num) ? [{ orderNumber: num }] : []), { customer: { name: { contains: term, mode: "insensitive" as const } } }, { customer: { nameAr: { contains: term } } }] } : {},
      include: { customer: { select: { name: true, nameAr: true } } },
      orderBy: { createdAt: "desc" }, take: 20,
    });
    const matched = await db.bankTransactionMatch.groupBy({ by: ["targetId"], where: { targetType: "ORDER", targetId: { in: orders.map((o) => o.id) }, active: true }, _sum: { amount: true } });
    return {
      kind: "ORDER",
      note: "Orders in this ERP carry no invoice value yet, so the outstanding amount cannot be computed; the receipts already matched to each order are shown.",
      rows: orders.map((o) => ({ id: o.id, label: `#${o.orderNumber} — ${o.customer.name}`, labelAr: `#${o.orderNumber} — ${o.customer.nameAr ?? o.customer.name}`, paymentStatus: o.paymentStatus, matched: toMinor(matched.find((m) => m.targetId === o.id)?._sum.amount) })),
    };
  }
  const obligations = await db.finObligation.findMany({
    where: { branchKey: t.branchKey, status: { in: ["OPEN", "PARTIALLY_PAID"] }, ...(term ? { OR: [{ description: { contains: term, mode: "insensitive" } }, { counterparty: { contains: term, mode: "insensitive" } }] } : {}) },
    orderBy: { dueDate: "asc" }, take: 20,
  });
  return { kind: "OBLIGATION", rows: obligations.map((o) => ({ id: o.id, label: `${o.description}${o.counterparty ? ` — ${o.counterparty}` : ""}`, amount: toMinor(o.amount), dueDate: o.dueDate.toISOString().slice(0, 10), status: o.status })) };
}

// ─── Attachments ─────────────────────────────────────────────────────────────

const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/csv"];

export async function addAttachment(actor: FinanceActor, scope: FinanceScope, txnId: string, file: File) {
  assertCan(actor, "txn_enter");
  const t = await prisma.bankTransaction.findUnique({ where: { id: txnId } });
  if (!t) throw new FinanceError("Not found", 404);
  assertScope(scope, t.branchKey);
  if (!ALLOWED_TYPES.includes(file.type)) throw new FinanceError("Only PDF, PNG, JPEG, WebP or CSV files.", 415);
  if (file.size > 5 * 1024 * 1024) throw new FinanceError("Attachments are limited to 5 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return prisma.$transaction(async (tx) => {
    const a = await tx.finAttachment.create({
      data: { entityType: "BankTransaction", entityId: txnId, fileName: file.name.slice(0, 200), contentType: file.type, sizeBytes: file.size, content: bytes, createdBy: actor.id },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true },
    });
    await audit(tx, { action: "attachment.added", entityType: "BankTransaction", entityId: txnId, branchKey: t.branchKey, after: a, userId: actor.id });
    return a;
  });
}

export async function getAttachment(scope: FinanceScope, id: string) {
  const a = await prisma.finAttachment.findUnique({ where: { id } });
  if (!a || a.entityType !== "BankTransaction") throw new FinanceError("Not found", 404);
  const t = await prisma.bankTransaction.findUnique({ where: { id: a.entityId }, select: { branchKey: true } });
  if (!t) throw new FinanceError("Not found", 404);
  assertScope(scope, t.branchKey);
  return a;
}
