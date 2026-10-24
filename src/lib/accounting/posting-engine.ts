// Accounting core A1 — THE posting engine. Every module posts through postEntry / reverseEntry; no module writes
// the ledger tables directly (council 02 · systems architect). Contract: docs/accounting/POSTING-CONTRACT.md.
//
//   postEntry(tx, { source, idempotencyKey?, date, lines, memo, createdBy })
//     • runs INSIDE THE CALLER'S TRANSACTION (`tx`), so an operational document and its entry commit or roll
//       back together;
//     • a NO-OP (returns { status: "skipped" }, writes nothing) while accounting is not activated, or for a date
//       before the go-live date — live operations are unaffected until the owner activates;
//     • idempotent per source event: one entry per (tenant, idempotencyKey), default
//       `${module}:${type}:${id}:${event}`; a retry returns the same entry (replayed: true), a retry with
//       different lines is refused (IDEMPOTENCY_CONFLICT). Concurrent retries serialise on an advisory lock;
//     • lines name a ROLE (resolved through AccountRole) or an account id; amounts are rounded once, HALF-UP to
//       2 dp (./money); a residue that comes only from that rounding is posted to the ROUNDING role and recorded
//       on the entry (roundingAmount); anything else unbalanced is refused;
//     • validates: ≥ 2 non-zero lines, one side each, positive amounts, balance, active postable leaf accounts,
//       AR / AP party, dimensions (branch, cost centre, customer / supplier / employee, item) exist, an OPEN
//       period (a missing Gregorian year is created on demand; soft-closed / closed are refused, or — on
//       request — moved to the next open period);
//     • the entry is born POSTED; the database then numbers it gaplessly and checks balance at commit.
//   reverseEntry(tx, { entryId, reason, date?, actorId }) — a mirrored REVERSAL entry, the original marked
//     REVERSED; idempotent (`reversal:<entryId>`).
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { roundMoney, toDecimal, Decimal, ZERO, MoneyError, type MoneyInput } from "./money";
import { dayText, riyadhDay, toBusinessDay, parseBusinessDay } from "./dates";
import { refuse } from "./refusals";
import { isRoleKey, roleDef } from "./roles";
import { setAuditContext, type AuditContext } from "./audit";
import { ensureFiscalYear } from "./fiscal-years";

type Tx = Prisma.TransactionClient;

export const ENGINE_MODULES = ["accounting", "sales", "purchasing", "inventory", "production", "payroll", "commissions", "pos"] as const;
export type EngineModule = (typeof ENGINE_MODULES)[number];
export const PARTY_TYPES = ["CUSTOMER", "SUPPLIER", "EMPLOYEE"] as const;
export const ITEM_TYPES = ["COFFEE_PRODUCT", "PRODUCT_SKU", "GREEN_BEAN", "MATERIAL"] as const;
export type PartyType = (typeof PARTY_TYPES)[number];
export type ItemType = (typeof ITEM_TYPES)[number];

export type PostingDims = {
  branchId?: string | null;
  costCenterId?: string | null;
  party?: { type: PartyType; id: string } | null;
  item?: { type: ItemType; id: string } | null;
};

export type PostingLineInput = {
  /** A posting role (src/lib/accounting/roles.ts) — what later phases use. */
  role?: string;
  /** Or an explicit account (the opening wizard, adjusting journals). Exactly one of role / accountId. */
  accountId?: string;
  debit?: MoneyInput | null;
  credit?: MoneyInput | null;
  description?: string | null;
  dims?: PostingDims;
};

export type PostEntryInput = {
  source: { module: EngineModule; type: string; id: string; event: string };
  idempotencyKey?: string;
  /** The business day (a "YYYY-MM-DD" or a Date; an instant is read as its Asia/Riyadh day). */
  date: Date | string;
  lines: PostingLineInput[];
  memo: string;
  createdBy: string;
  /** AUTO (default), OPENING (the opening-balance wizard) or CLOSING (A5: the year-end close, which posts into a
   *  soft-closed December — the one posting a LOCKED period takes; a CLOSED period is refused as always). */
  entryType?: "AUTO" | "OPENING" | "CLOSING";
  /** When the date's period is soft-closed or closed: refuse (default) or post on the first day of the next OPEN period. */
  whenPeriodNotOpen?: "reject" | "nextOpenPeriod";
  /** Sets the transaction's audit context first (actor, IP, device, reason). */
  audit?: AuditContext;
};

export type PostEntryResult =
  | { status: "posted"; entryId: string; replayed: boolean; postingYear: number | null; postingSeq: number | null; entryDate: string; roundingAmount: string | null }
  | { status: "skipped"; reason: "NOT_ACTIVE" | "BEFORE_GO_LIVE" };

export type NormalLine = {
  role: string | null;
  accountId: string | null;
  debit: Decimal;
  credit: Decimal;
  description: string | null;
  dims: { branchId: string | null; costCenterId: string | null; partyType: PartyType | null; partyId: string | null; itemType: ItemType | null; itemId: string | null };
};

const KEY_RE = /^[A-Za-z0-9:_\-./]{3,200}$/;
const TOKEN_RE = /^[A-Za-z0-9_\-.]{1,120}$/;

/** `${module}:${type}:${id}:${event}` — the idempotency key of a source event. */
export function defaultIdempotencyKey(source: PostEntryInput["source"]): string {
  return `${source.module}:${source.type}:${source.id}:${source.event}`;
}

function str(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw refuse("BAD_INPUT", "A text field is not a string.");
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Pure: normalise and balance the lines. Rounds each amount HALF-UP to 2 dp. When the UNROUNDED lines balance
 * exactly but the rounded ones do not, the residue (necessarily ≤ 0.005 per line) goes to the ROUNDING role.
 * Refuses: fewer than two lines, a line with both or neither side, a negative or zero amount, an unbalanced entry.
 */
export function normaliseLines(lines: PostingLineInput[]): { lines: NormalLine[]; total: Decimal; rounding: Decimal } {
  if (!Array.isArray(lines) || lines.length < 2) throw refuse("LINES_MIN");
  let rawD = ZERO, rawC = ZERO;
  const out: NormalLine[] = lines.map((l, i) => {
    if (!l || typeof l !== "object") throw refuse("BAD_INPUT", `Line ${i + 1} is not an object.`);
    const hasRole = l.role !== undefined && l.role !== null;
    const hasAcc = l.accountId !== undefined && l.accountId !== null;
    if (hasRole === hasAcc) throw refuse("BAD_INPUT", `Line ${i + 1} names exactly one of role / accountId.`);
    if (hasRole && !isRoleKey(l.role)) throw refuse("ROLE_UNKNOWN", `(${String(l.role)})`);
    if (hasAcc && (typeof l.accountId !== "string" || !l.accountId)) throw refuse("BAD_INPUT", `Line ${i + 1}: accountId.`);
    let d: Decimal, c: Decimal;
    try {
      d = l.debit === undefined || l.debit === null || l.debit === "" ? ZERO : toDecimal(l.debit);
      c = l.credit === undefined || l.credit === null || l.credit === "" ? ZERO : toDecimal(l.credit);
    } catch (e) {
      if (e instanceof MoneyError) throw refuse("AMOUNT", `Line ${i + 1}: ${e.message}`);
      throw e;
    }
    if (d.isNegative() || c.isNegative() || d.isZero() === c.isZero()) throw refuse("LINE_SIDE", `(line ${i + 1})`);
    rawD = rawD.plus(d);
    rawC = rawC.plus(c);
    const dims = l.dims ?? {};
    const party = dims.party ?? null;
    const item = dims.item ?? null;
    if (party && (!PARTY_TYPES.includes(party.type) || typeof party.id !== "string" || !party.id)) throw refuse("BAD_INPUT", `Line ${i + 1}: party.`);
    if (item && (!ITEM_TYPES.includes(item.type) || typeof item.id !== "string" || !item.id)) throw refuse("BAD_INPUT", `Line ${i + 1}: item.`);
    let dr: Decimal, cr: Decimal;
    try { dr = roundMoney(d); cr = roundMoney(c); } catch (e) { if (e instanceof MoneyError) throw refuse("AMOUNT", `Line ${i + 1}: ${e.message}`); throw e; }
    if (dr.isZero() && cr.isZero()) throw refuse("AMOUNT", `Line ${i + 1} rounds to zero.`);
    return {
      role: hasRole ? (l.role as string) : null,
      accountId: hasAcc ? (l.accountId as string) : null,
      debit: dr,
      credit: cr,
      description: str(l.description, 500),
      dims: { branchId: str(dims.branchId, 64), costCenterId: str(dims.costCenterId, 64), partyType: party?.type ?? null, partyId: party?.id ?? null, itemType: item?.type ?? null, itemId: item?.id ?? null },
    };
  });
  if (!rawD.equals(rawC)) throw refuse("UNBALANCED", `(debit ${rawD.toFixed()} ≠ credit ${rawC.toFixed()})`);
  const d = out.reduce((s, l) => s.plus(l.debit), ZERO);
  const c = out.reduce((s, l) => s.plus(l.credit), ZERO);
  const diff = d.minus(c);
  if (!diff.isZero()) {
    if (diff.abs().greaterThan(new Decimal("0.005").times(out.length))) throw refuse("ROUNDING_TOO_LARGE");
    out.push({
      role: "ROUNDING", accountId: null,
      debit: diff.isNegative() ? diff.abs() : ZERO, credit: diff.isNegative() ? ZERO : diff,
      description: "فرق تقريب (نصف للأعلى، منزلتان)",
      dims: { branchId: null, costCenterId: null, partyType: null, partyId: null, itemType: null, itemId: null },
    });
  }
  const total = out.reduce((s, l) => s.plus(l.debit), ZERO);
  return { lines: out, total, rounding: diff };
}

/** sha256 of the normalised content (date + lines): what a retry must match. */
export function payloadHash(date: Date, lines: NormalLine[]): string {
  const canon = JSON.stringify({ date: dayText(date), lines: lines.map((l) => [l.role, l.accountId, l.debit.toFixed(2), l.credit.toFixed(2), l.description, l.dims]) });
  return createHash("sha256").update(canon).digest("hex");
}

function businessDay(date: Date | string): Date {
  if (typeof date === "string") {
    try { return parseBusinessDay(date); } catch { throw refuse("BAD_INPUT", "date is YYYY-MM-DD."); }
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw refuse("BAD_INPUT", "date.");
  return toBusinessDay(date);
}

/** The accounts of these roles (refuses unknown or unmapped roles, listing every missing one). */
export async function resolveRoles(tx: Tx, roles: string[]): Promise<Map<string, string>> {
  const want = [...new Set(roles)];
  for (const r of want) if (!isRoleKey(r)) throw refuse("ROLE_UNKNOWN", `(${r})`);
  if (!want.length) return new Map();
  const rows = await tx.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: want } }, select: { role: true, accountId: true } });
  const map = new Map(rows.map((r) => [r.role, r.accountId]));
  const missing = want.filter((r) => !map.has(r));
  if (missing.length) throw refuse("ROLE_NOT_MAPPED", `(${missing.join(", ")})`, `(${missing.map((m) => roleDef(m)?.ar ?? m).join("، ")})`);
  return map;
}

/** Later phases: refuse early (before any write) when a role they need is unmapped. */
export async function assertRolesMapped(tx: Tx, roles: string[]): Promise<void> {
  await resolveRoles(tx, roles);
}

type AccountRow = { id: string; code: string; isActive: boolean; allowPosting: boolean; controlType: string | null; allowManualJournal: boolean; type: string; children: number };

export async function loadAccounts(tx: Tx, ids: string[]): Promise<Map<string, AccountRow>> {
  const uniq = [...new Set(ids)];
  const rows = await tx.account.findMany({
    where: { id: { in: uniq } },
    select: { id: true, code: true, isActive: true, allowPosting: true, controlType: true, allowManualJournal: true, type: true, _count: { select: { children: true } } },
  });
  return new Map(rows.map((a) => [a.id, { ...a, type: String(a.type), children: a._count.children }]));
}

/** Postable leaf, active; AR / AP lines name the right party kind. `manual`: control accounts are refused. */
export function checkLineAccount(a: AccountRow | undefined, line: Pick<NormalLine, "dims">, opts: { manual?: boolean } = {}): void {
  if (!a) throw refuse("ACCOUNT_NOT_FOUND");
  if (!a.isActive || !a.allowPosting || a.children > 0) throw refuse("ACCOUNT_NOT_POSTABLE", `(${a.code})`, `(${a.code})`);
  if (opts.manual && !a.allowManualJournal) throw refuse("CONTROL_ACCOUNT_MANUAL", `(${a.code})`, `(${a.code})`);
  if (a.controlType === "AR" || a.controlType === "AP") {
    if (!line.dims.partyId) throw refuse("PARTY_REQUIRED", `(${a.code})`, `(${a.code})`);
    if ((a.controlType === "AR" && line.dims.partyType !== "CUSTOMER") || (a.controlType === "AP" && line.dims.partyType !== "SUPPLIER")) throw refuse("PARTY_TYPE", `(${a.code})`);
  }
}

/** Every named dimension exists (one query per kind present). */
export async function checkDimensions(tx: Tx, lines: Pick<NormalLine, "dims">[]): Promise<void> {
  const ids = (pick: (l: NormalLine["dims"]) => string | null) => [...new Set(lines.map((l) => pick(l.dims)).filter((x): x is string => !!x))];
  const party = (t: PartyType) => ids((d) => (d.partyType === t ? d.partyId : null));
  const item = (t: ItemType) => ids((d) => (d.itemType === t ? d.itemId : null));
  const checks: [string, string[], (w: string[]) => Promise<number>][] = [
    ["branch", ids((d) => d.branchId), (w) => tx.finBranch.count({ where: { id: { in: w } } })],
    ["cost centre", ids((d) => d.costCenterId), (w) => tx.finCostCenter.count({ where: { id: { in: w } } })],
    ["customer", party("CUSTOMER"), (w) => tx.customer.count({ where: { id: { in: w } } })],
    ["supplier", party("SUPPLIER"), (w) => tx.supplier.count({ where: { id: { in: w } } })],
    ["employee", party("EMPLOYEE"), (w) => tx.hrEmployee.count({ where: { id: { in: w } } })],
    ["product", item("COFFEE_PRODUCT"), (w) => tx.coffeeProduct.count({ where: { id: { in: w } } })],
    ["SKU", item("PRODUCT_SKU"), (w) => tx.productSKU.count({ where: { id: { in: w } } })],
    ["green bean", item("GREEN_BEAN"), (w) => tx.greenBean.count({ where: { id: { in: w } } })],
    ["material", item("MATERIAL"), (w) => tx.materialItem.count({ where: { id: { in: w } } })],
  ];
  for (const [what, want, count] of checks) {
    if (want.length && (await count(want)) !== want.length) throw refuse("DIMENSION_NOT_FOUND", `(${what})`);
  }
}

/**
 * The OPEN period of a business day (creating the Gregorian year on demand). Soft-closed / closed: refused, or —
 * `nextOpenPeriod` — the first day of the earliest OPEN period after it.
 */
export async function openPeriodFor(tx: Tx, day: Date, policy: "reject" | "nextOpenPeriod" = "reject", opts: { allowSoftClosed?: boolean } = {}): Promise<{ id: string; day: Date; moved: boolean }> {
  let p = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: day }, endDate: { gte: day } }, select: { id: true, status: true, endDate: true } });
  if (!p) {
    await ensureFiscalYear(tx, day.getUTCFullYear());
    p = await tx.fiscalPeriod.findFirst({ where: { startDate: { lte: day }, endDate: { gte: day } }, select: { id: true, status: true, endDate: true } });
    if (!p) throw refuse("PERIOD_MISSING", `(${dayText(day)})`, `(${dayText(day)})`);
  }
  if (p.status === "OPEN" || (p.status === "LOCKED" && opts.allowSoftClosed)) return { id: p.id, day, moved: false };
  if (policy === "nextOpenPeriod") {
    // A5 council fix: a soft-closed December must not stop the floor — the next year is created on demand, as the
    // engine already does for a missing year, so the operation posts on 1 January.
    if (!(await tx.fiscalPeriod.findFirst({ where: { status: "OPEN", startDate: { gt: day } }, select: { id: true } }))) await ensureFiscalYear(tx, day.getUTCFullYear() + 1);
    const next = await tx.fiscalPeriod.findFirst({ where: { status: "OPEN", startDate: { gt: day } }, orderBy: { startDate: "asc" }, select: { id: true, startDate: true } });
    if (next) return { id: next.id, day: next.startDate, moved: true };
  }
  throw p.status === "CLOSED" ? refuse("PERIOD_CLOSED", `(${dayText(day)})`, `(${dayText(day)})`) : refuse("PERIOD_SOFT_CLOSED", `(${dayText(day)})`, `(${dayText(day)})`);
}

/** The engine's switch: activated, and the day on / after the go-live date. */
export async function engineState(tx: Tx, day: Date): Promise<{ on: true } | { on: false; reason: "NOT_ACTIVE" | "BEFORE_GO_LIVE" }> {
  const s = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true, goLiveDate: true } });
  if (!s?.accountingActive || !s.goLiveDate) return { on: false, reason: "NOT_ACTIVE" };
  if (day < s.goLiveDate) return { on: false, reason: "BEFORE_GO_LIVE" };
  return { on: true };
}

export async function postEntry(tx: Tx, input: PostEntryInput): Promise<PostEntryResult> {
  const src = input?.source;
  if (!src || !(ENGINE_MODULES as readonly string[]).includes(src.module)) throw refuse("BAD_INPUT", "source.module is not an engine module.");
  if (!TOKEN_RE.test(String(src.type)) || !TOKEN_RE.test(String(src.event)) || typeof src.id !== "string" || !src.id || src.id.length > 120) {
    throw refuse("BAD_INPUT", "source { type, id, event } are short tokens.");
  }
  if (typeof input.createdBy !== "string" || !input.createdBy) throw refuse("BAD_INPUT", "createdBy.");
  const memo = str(input.memo, 500);
  if (!memo) throw refuse("BAD_INPUT", "memo.");
  const day = businessDay(input.date);

  // Validated before the switch is consulted: a malformed posting is a bug whether or not accounting is on.
  const norm = normaliseLines(input.lines);

  const state = await engineState(tx, day);
  if (!state.on) return { status: "skipped", reason: state.reason };
  if (input.audit) await setAuditContext(tx, input.audit);

  const key = input.idempotencyKey ?? defaultIdempotencyKey(src);
  if (!KEY_RE.test(key)) throw refuse("BAD_INPUT", "idempotencyKey.");
  const hash = payloadHash(day, norm.lines);
  // Serialise concurrent retries of the same event; the second waits, then — in a NEW statement, so with a
  // fresh READ COMMITTED snapshot — sees the first one's committed entry.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"je:" + key}, 0))`;
  const hit = await tx.journalEntry.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: "hiqbah", idempotencyKey: key } },
    select: { id: true, payloadHash: true, postingYear: true, postingSeq: true, entryDate: true, roundingAmount: true },
  });
  if (hit) {
    if (hit.payloadHash !== hash) throw refuse("IDEMPOTENCY_CONFLICT", `(${key})`);
    return { status: "posted", entryId: hit.id, replayed: true, postingYear: hit.postingYear, postingSeq: hit.postingSeq, entryDate: dayText(hit.entryDate), roundingAmount: hit.roundingAmount ? hit.roundingAmount.toFixed(2) : null };
  }

  const roleMap = await resolveRoles(tx, norm.lines.filter((l) => l.role).map((l) => l.role as string));
  const resolved = norm.lines.map((l) => ({ ...l, accountId: l.accountId ?? (roleMap.get(l.role as string) as string) }));
  const accounts = await loadAccounts(tx, resolved.map((l) => l.accountId));
  for (const l of resolved) checkLineAccount(accounts.get(l.accountId), l);
  await checkDimensions(tx, resolved);
  const period = await openPeriodFor(tx, day, input.whenPeriodNotOpen ?? "reject", { allowSoftClosed: input.entryType === "CLOSING" });
  if (period.moved) {
    const after = await engineState(tx, period.day);
    if (!after.on) return { status: "skipped", reason: after.reason };
  }

  const now = new Date();
  const entry = await tx.journalEntry.create({
    data: {
      entryDate: period.day,
      fiscalPeriodId: period.id,
      type: input.entryType === "OPENING" || input.entryType === "CLOSING" ? input.entryType : "AUTO",
      status: "POSTED",
      sourceModule: src.module,
      sourceDocumentId: src.id,
      sourceType: src.type,
      sourceId: src.id,
      sourceEvent: src.event,
      idempotencyKey: key,
      payloadHash: hash,
      description: period.moved ? `${memo} (event of ${dayText(day)}; its period was not open)`.slice(0, 500) : memo,
      totalDebit: norm.total,
      totalCredit: norm.total,
      roundingAmount: norm.rounding.isZero() ? null : norm.rounding.abs(),
      createdBy: input.createdBy,
      approvedAt: now,
      approvedBy: input.createdBy,
      postedAt: now,
      postedBy: input.createdBy,
      lines: {
        create: resolved.map((l, i) => ({
          lineNo: i + 1,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description ?? (l.role ? roleDef(l.role)?.ar ?? roleDef(l.role)?.en ?? null : null),
          branchId: l.dims.branchId,
          costCenterId: l.dims.costCenterId,
          partyType: l.dims.partyType,
          partyId: l.dims.partyId,
          itemType: l.dims.itemType,
          itemId: l.dims.itemId,
        })),
      },
    },
    select: { id: true, postingYear: true, postingSeq: true, entryDate: true, roundingAmount: true },
  });
  return { status: "posted", entryId: entry.id, replayed: false, postingYear: entry.postingYear, postingSeq: entry.postingSeq, entryDate: dayText(entry.entryDate), roundingAmount: entry.roundingAmount ? entry.roundingAmount.toFixed(2) : null };
}

export type ReverseEntryInput = { entryId: string; reason: string; actorId: string; date?: Date | string; audit?: AuditContext };

/** A mirrored REVERSAL of an ENGINE entry (manual journals: journal-service; HR journals: through HR only). */
export async function reverseEntry(tx: Tx, input: ReverseEntryInput): Promise<{ entryId: string; replayed: boolean }> {
  const reason = str(input.reason, 500);
  if (!reason || reason.length < 3) throw refuse("REASON_REQUIRED");
  if (input.audit) await setAuditContext(tx, { ...input.audit, reason });
  const original = await tx.journalEntry.findUnique({ where: { id: input.entryId }, include: { lines: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] }, reversedByEntry: { select: { id: true } } } });
  if (!original) throw refuse("NOT_FOUND");
  if ((original.sourceModule ?? "").trim().toLowerCase() === "hr") throw refuse("HR_JOURNAL");
  if (!original.idempotencyKey || !(ENGINE_MODULES as readonly string[]).includes(original.sourceModule)) throw refuse("NOT_ENGINE_ENTRY");
  if (original.type === "OPENING") throw refuse("OPENING_FINAL");
  if (original.type === "CLOSING") throw refuse("CLOSING_FINAL"); // A5: the year-end close is final
  const key = `reversal:${original.id}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"je:" + key}, 0))`;
  const prior = await tx.journalEntry.findUnique({ where: { tenantId_idempotencyKey: { tenantId: "hiqbah", idempotencyKey: key } }, select: { id: true } });
  if (prior) return { entryId: prior.id, replayed: true };
  if (original.reversedByEntry) throw refuse("ALREADY_REVERSED");
  if (original.status !== "POSTED") throw refuse("NOT_POSTED");
  const day = input.date ? businessDay(input.date) : riyadhDay();
  if (day < original.entryDate) throw refuse("REVERSAL_BEFORE_ORIGINAL");
  const state = await engineState(tx, day);
  if (!state.on) throw refuse(state.reason === "NOT_ACTIVE" ? "NOT_ACTIVE" : "BEFORE_GO_LIVE");
  const period = await openPeriodFor(tx, day);
  const lines = original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
  const now = new Date();
  const rev = await tx.journalEntry.create({
    data: {
      entryDate: period.day, fiscalPeriodId: period.id, type: "REVERSAL", status: "POSTED",
      sourceModule: original.sourceModule, sourceDocumentId: original.sourceDocumentId,
      sourceType: original.sourceType, sourceId: original.sourceId, sourceEvent: `${original.sourceEvent ?? "EVENT"}.REVERSED`.slice(0, 120),
      idempotencyKey: key, payloadHash: payloadHash(period.day, lines.map((l) => ({ role: null, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description, dims: { branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType as PartyType | null, partyId: l.partyId, itemType: l.itemType as ItemType | null, itemId: l.itemId } }))),
      reversesEntryId: original.id, reversalReason: reason,
      description: (() => { const ref = original.postingYear ? `JE-${original.postingYear}-${String(original.postingSeq).padStart(6, "0")}` : `#${original.entryNo}`; return `عكس القيد ${ref}: ${reason}`.slice(0, 500); })(),
      totalDebit: original.totalCredit, totalCredit: original.totalDebit,
      createdBy: input.actorId, approvedAt: now, approvedBy: input.actorId, postedAt: now, postedBy: input.actorId,
      lines: { create: lines.map((l, i) => ({ lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description ? `Reversal: ${l.description}`.slice(0, 500) : "Reversal", branchId: l.branchId, costCenterId: l.costCenterId, partyType: l.partyType, partyId: l.partyId, itemType: l.itemType, itemId: l.itemId })) },
    },
    select: { id: true },
  });
  await tx.journalEntry.update({ where: { id: original.id }, data: { status: "REVERSED", reversedAt: now, reversedBy: input.actorId } });
  return { entryId: rev.id, replayed: false };
}

/** postEntry in its own transaction (for callers that have none, e.g. the opening wizard's route). */
export async function postEntryStandalone(input: PostEntryInput): Promise<PostEntryResult> {
  return prisma.$transaction((tx) => postEntry(tx, input), TX_OPTS);
}

/** "JE-2026-000123" — the gapless posting reference (null before posting). */
export function postingRef(e: { postingYear: number | null; postingSeq: number | null }): string | null {
  return e.postingYear && e.postingSeq ? `JE-${e.postingYear}-${String(e.postingSeq).padStart(6, "0")}` : null;
}
