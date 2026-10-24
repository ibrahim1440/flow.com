// Accounting core A1 — the opening-balance wizard. The trial balance carried in from the old books, entered as
// a grid (by hand or from CSV), posted ONCE as the OPENING entry dated the go-live date; the difference between
// the grid's debits and credits goes to the OPENING_BALANCE_EQUITY role (the accountant clears it to retained
// earnings / capital by an adjusting journal). AR / AP opening balances are entered PER PARTY (customer /
// supplier): those lines are the opening of the AR / AP sub-ledgers A2 / A3 build on. After posting, the grid
// is frozen by the database and the entry is final (a correction is an adjusting journal).
import { prisma, TX_OPTS } from "@/lib/db";
import { Decimal, ZERO, roundMoney, toDecimal, MoneyError } from "./money";
import { dayText } from "./dates";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";
import { checkDimensions, checkLineAccount, loadAccounts, postEntry, resolveRoles, PARTY_TYPES, type PartyType, type NormalLine, type PostingLineInput } from "./posting-engine";
import { getSettings } from "./setup";

export type OpeningLineInput = { accountId: string; debit?: string | null; credit?: string | null; partyType?: string | null; partyId?: string | null; branchId?: string | null; costCenterId?: string | null; description?: string | null };

type Clean = { accountId: string; debit: Decimal; credit: Decimal; partyType: PartyType | null; partyId: string | null; branchId: string | null; costCenterId: string | null; description: string | null };

const s = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function clean(lines: OpeningLineInput[]): Clean[] {
  if (!Array.isArray(lines)) throw refuse("BAD_INPUT", "lines is an array.");
  if (lines.length > 2000) throw refuse("BAD_INPUT", "At most 2000 lines.");
  return lines.map((l, i) => {
    if (!l || typeof l !== "object" || typeof l.accountId !== "string" || !l.accountId) throw refuse("BAD_INPUT", `Line ${i + 1}: accountId.`);
    let d: Decimal, c: Decimal;
    try {
      d = l.debit ? roundMoney(toDecimal(String(l.debit))) : ZERO;
      c = l.credit ? roundMoney(toDecimal(String(l.credit))) : ZERO;
    } catch (e) {
      if (e instanceof MoneyError) throw refuse("AMOUNT", `Line ${i + 1}: ${e.message}`);
      throw e;
    }
    if (d.isNegative() || c.isNegative() || d.isZero() === c.isZero()) throw refuse("LINE_SIDE", `(line ${i + 1})`);
    const pt = s(l.partyType, 20);
    if (pt && !(PARTY_TYPES as readonly string[]).includes(pt)) throw refuse("BAD_INPUT", `Line ${i + 1}: partyType.`);
    const pid = s(l.partyId, 64);
    if (!!pt !== !!pid) throw refuse("BAD_INPUT", `Line ${i + 1}: partyType and partyId go together.`);
    return { accountId: l.accountId, debit: d, credit: c, partyType: pt as PartyType | null, partyId: pid, branchId: s(l.branchId, 64), costCenterId: s(l.costCenterId, 64), description: s(l.description, 300) };
  });
}

const dims = (l: Clean): NormalLine["dims"] => ({ branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId, itemType: null, itemId: null });

export async function getOpening() {
  const st = await getSettings();
  const lines = await prisma.openingBalanceLine.findMany({ orderBy: { lineNo: "asc" }, include: { account: { select: { code: true, nameAr: true, nameEn: true, type: true, controlType: true } } } });
  const d = lines.reduce((x, l) => x.plus(l.debit), ZERO);
  const c = lines.reduce((x, l) => x.plus(l.credit), ZERO);
  const obe = await prisma.accountRole.findUnique({ where: { tenantId_role: { tenantId: "hiqbah", role: "OPENING_BALANCE_EQUITY" } }, include: { account: { select: { code: true, nameAr: true, nameEn: true } } } });
  const entry = st.openingEntryId ? await prisma.journalEntry.findUnique({ where: { id: st.openingEntryId }, select: { id: true, postingYear: true, postingSeq: true, entryDate: true, totalDebit: true, postedAt: true, postedBy: true } }) : null;
  return {
    goLiveDate: st.goLiveDate ? dayText(st.goLiveDate) : null,
    active: st.accountingActive,
    posted: !!st.openingEntryId,
    entry: entry ? { ...entry, entryDate: dayText(entry.entryDate), totalDebit: entry.totalDebit.toFixed(2) } : null,
    equityAccount: obe ? { id: obe.accountId, code: obe.account.code, name: obe.account.nameAr ?? obe.account.nameEn } : null,
    lines: lines.map((l) => ({ id: l.id, lineNo: l.lineNo, accountId: l.accountId, account: { ...l.account, type: String(l.account.type) }, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), partyType: l.partyType, partyId: l.partyId, branchId: l.branchId, costCenterId: l.costCenterId, description: l.description })),
    totals: { debit: d.toFixed(2), credit: c.toFixed(2), difference: d.minus(c).toFixed(2) },
  };
}

/** Replace the whole grid (validated like a posting: postable leaf accounts, AR / AP by party, dimensions exist). */
export async function replaceOpeningLines(input: OpeningLineInput[], ctx: AuditContext) {
  const lines = clean(input);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if ((await getSettings(tx)).openingEntryId) throw refuse("OPENING_POSTED");
    const accounts = await loadAccounts(tx, lines.map((l) => l.accountId));
    for (const l of lines) checkLineAccount(accounts.get(l.accountId), { dims: dims(l) });
    await checkDimensions(tx, lines.map((l) => ({ dims: dims(l) })));
    await tx.openingBalanceLine.deleteMany({});
    if (lines.length) {
      await tx.openingBalanceLine.createMany({ data: lines.map((l, i) => ({ lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, partyType: l.partyType, partyId: l.partyId, branchId: l.branchId, costCenterId: l.costCenterId, description: l.description, updatedBy: ctx.actorId })) });
    }
    return lines.length;
  }, TX_OPTS);
}

/**
 * CSV → grid lines. Header (any order, case-insensitive): account_code, debit, credit, party_type, party,
 * branch_code, description. `party` is the party's id, or — customers and suppliers — its exact name, or —
 * employees — its employee number. Returns the lines and the per-row problems (nothing is written here).
 */
export async function parseOpeningCsv(text: string): Promise<{ lines: OpeningLineInput[]; problems: { row: number; en: string; ar: string }[] }> {
  if (typeof text !== "string" || !text.trim()) throw refuse("BAD_INPUT", "The CSV is empty.");
  if (text.length > 1_000_000) throw refuse("BAD_INPUT", "The CSV is larger than 1 MB.");
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  if (col("account_code") < 0 || (col("debit") < 0 && col("credit") < 0)) throw refuse("BAD_INPUT", "The CSV needs account_code and debit / credit columns.");
  const accounts = new Map((await prisma.account.findMany({ select: { id: true, code: true } })).map((a) => [a.code, a.id]));
  const branches = new Map((await prisma.finBranch.findMany({ select: { id: true, code: true } })).map((b) => [b.code, b.id]));
  const problems: { row: number; en: string; ar: string }[] = [];
  const lines: OpeningLineInput[] = [];
  const cell = (r: string[], n: string) => (col(n) >= 0 ? (r[col(n)] ?? "").trim() : "");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => !c.trim())) continue;
    const rowNo = i + 2;
    const accountId = accounts.get(cell(r, "account_code"));
    if (!accountId) { problems.push({ row: rowNo, en: `Unknown account code "${cell(r, "account_code")}".`, ar: `رمز حساب غير معروف «${cell(r, "account_code")}».` }); continue; }
    const pt = cell(r, "party_type").toUpperCase() || null;
    const pref = cell(r, "party") || null;
    let partyId: string | null = null;
    if (pt || pref) {
      if (!pt || !pref || !(PARTY_TYPES as readonly string[]).includes(pt)) { problems.push({ row: rowNo, en: "party_type (CUSTOMER / SUPPLIER / EMPLOYEE) and party go together.", ar: "نوع الطرف (CUSTOMER / SUPPLIER / EMPLOYEE) والطرف يُذكران معًا." }); continue; }
      partyId = await resolveParty(pt as PartyType, pref);
      if (!partyId) { problems.push({ row: rowNo, en: `${pt} "${pref}" not found (or not unique).`, ar: `الطرف «${pref}» غير موجود أو غير فريد.` }); continue; }
    }
    const bc = cell(r, "branch_code");
    const branchId = bc ? branches.get(bc) ?? null : null;
    if (bc && !branchId) { problems.push({ row: rowNo, en: `Unknown branch code "${bc}".`, ar: `رمز فرع غير معروف «${bc}».` }); continue; }
    lines.push({ accountId, debit: cell(r, "debit").replace(/,/g, "") || null, credit: cell(r, "credit").replace(/,/g, "") || null, partyType: pt, partyId, branchId, description: cell(r, "description") || null });
  }
  // Validate the amounts / sides now, reporting by row rather than failing on the first.
  lines.forEach((l, i) => { try { clean([l]); } catch (e) { problems.push({ row: i + 2, en: (e as Error).message, ar: (e as { messageAr?: string }).messageAr ?? (e as Error).message }); } });
  return { lines, problems };
}

async function resolveParty(t: PartyType, ref: string): Promise<string | null> {
  if (t === "CUSTOMER") {
    const byId = await prisma.customer.findUnique({ where: { id: ref }, select: { id: true } });
    if (byId) return byId.id;
    const byName = await prisma.customer.findMany({ where: { name: ref }, select: { id: true }, take: 2 });
    return byName.length === 1 ? byName[0].id : null;
  }
  if (t === "SUPPLIER") {
    const byId = await prisma.supplier.findUnique({ where: { id: ref }, select: { id: true } });
    if (byId) return byId.id;
    const byName = await prisma.supplier.findMany({ where: { name: ref }, select: { id: true }, take: 2 });
    return byName.length === 1 ? byName[0].id : null;
  }
  const e = await prisma.hrEmployee.findFirst({ where: { OR: [{ id: ref }, { employeeNo: ref }] }, select: { id: true } });
  return e?.id ?? null;
}

/** RFC 4180-ish: quotes, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); out.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

/** Post the grid as the OPENING entry at the go-live date (accounting must be active; once only). */
export async function postOpening(ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('accounting:opening', 0))`;
    const st = await getSettings(tx);
    if (st.openingEntryId) throw refuse("OPENING_POSTED");
    if (!st.accountingActive || !st.goLiveDate) throw refuse("NOT_ACTIVE");
    const grid = await tx.openingBalanceLine.findMany({ orderBy: { lineNo: "asc" } });
    if (!grid.length) throw refuse("OPENING_EMPTY");
    await resolveRoles(tx, ["OPENING_BALANCE_EQUITY"]);
    const d = grid.reduce((x, l) => x.plus(l.debit), ZERO);
    const c = grid.reduce((x, l) => x.plus(l.credit), ZERO);
    const diff = d.minus(c);
    const lines: PostingLineInput[] = grid.map((l) => ({
      accountId: l.accountId, debit: l.debit.isZero() ? null : l.debit.toFixed(2), credit: l.credit.isZero() ? null : l.credit.toFixed(2), description: l.description ?? "Opening balance",
      dims: { branchId: l.branchId, costCenterId: l.costCenterId, party: l.partyType && l.partyId ? { type: l.partyType as PartyType, id: l.partyId } : null },
    }));
    // The difference closes the entry against opening balance equity (credit when the debits are larger).
    if (!diff.isZero()) lines.push({ role: "OPENING_BALANCE_EQUITY", debit: diff.isNegative() ? diff.abs().toFixed(2) : null, credit: diff.isNegative() ? null : diff.toFixed(2), description: "Opening balance equity (difference)" });
    const res = await postEntry(tx, {
      source: { module: "accounting", type: "OPENING_BALANCE", id: dayText(st.goLiveDate), event: "POSTED" },
      date: dayText(st.goLiveDate),
      lines,
      memo: `الأرصدة الافتتاحية في ${dayText(st.goLiveDate)}`,
      createdBy: ctx.actorId,
      entryType: "OPENING",
    });
    if (res.status !== "posted") throw refuse("NOT_ACTIVE");
    await tx.accountingSettings.update({ where: { id: "singleton" }, data: { openingEntryId: res.entryId, updatedBy: ctx.actorId } });
    return res;
  }, TX_OPTS);
}
