// «الموقع» — the location dimension (BATCH22 WP-B, 20261125090000_location_dimension). The dimension posted and reported
// is the ledger's own "JournalEntryLine"."branchId" (FinBranch), shown as «الموقع» in the accountant workspace; a stock
// site (StockLocation) maps to a branch ("finBranchId"). A document carries ONE location on its header (council Q-F1) and
// the posting engine stamps it on every line of its entry (PostEntryInput.defaultBranchId). NULL = «غير محدد».
//
// The defaults (server-side, only when the input names none):
//   Order            the creator's HrEmployee.branchId → their only FinBranchAccess branch → the production site's branch
//   SalesInvoice     the order's branch; no order: as for an order (the requester). NEVER the delivery's site (Q-F4)
//   SalesCollection  the branch the order's issued invoices share; else the order's; else the recorder's
//   SupplierInvoice  the receiving site's branch; else the creator's
//   SupplierPayment  the branch every allocated invoice shares; else NULL (the screen warns)
//   COGS of a delivery  the ORDER's branch (the selling site), while the stock leaves the delivery's site (Q-F4)
// A document's location is editable until it is posted / issued, then frozen (the database: location_branch_frozen and
// sinv_invoice_guard); a change after that is a reclass journal.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { refuse } from "./refusals";

type Db = Prisma.TransactionClient | typeof prisma;

/** The «غير محدد» token of a location filter (a document / line with no location). */
export const UNASSIGNED = "none";

/**
 * A location given by a request: `undefined` when the field is absent (keep / default), `null` when it is cleared
 * ("" or null), else the id of an ACTIVE branch (refused otherwise: LOCATION_INVALID).
 */
export async function parseBranchId(db: Db, v: unknown): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 64) throw refuse("LOCATION_INVALID");
  const b = await db.finBranch.findUnique({ where: { id: v }, select: { active: true } });
  if (!b?.active) throw refuse("LOCATION_INVALID");
  return v;
}

async function activeBranch(db: Db, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const b = await db.finBranch.findUnique({ where: { id }, select: { active: true } });
  return b?.active ? id : null;
}

/** The production site's branch (the company's default profit centre), or null. */
export async function productionBranchId(db: Db): Promise<string | null> {
  const p = await db.stockLocation.findFirst({ where: { isProduction: true }, select: { finBranchId: true } });
  return activeBranch(db, p?.finBranchId);
}

/** A person's default location: their HR record's branch → their only branch access → the production site's branch. */
export async function defaultBranchForActor(db: Db, employeeId: string | null | undefined): Promise<string | null> {
  if (employeeId) {
    const hr = await db.hrEmployee.findUnique({ where: { accountId: employeeId }, select: { branchId: true } });
    const own = await activeBranch(db, hr?.branchId);
    if (own) return own;
    const access = await db.finBranchAccess.findMany({ where: { employeeId, branch: { active: true } }, select: { branchId: true }, take: 2 });
    if (access.length === 1) return access[0].branchId;
  }
  return productionBranchId(db);
}

/** A stock site's branch (null for TRANSIT / an unmapped site). */
export async function siteBranchId(db: Db, locationId: string | null | undefined): Promise<string | null> {
  if (!locationId) return null;
  const l = await db.stockLocation.findUnique({ where: { id: locationId }, select: { finBranchId: true } });
  return activeBranch(db, l?.finBranchId);
}

/** The order's branch, or null. */
export async function orderBranchId(db: Db, orderId: string | null | undefined): Promise<string | null> {
  if (!orderId) return null;
  const o = await db.order.findUnique({ where: { id: orderId }, select: { branchId: true } });
  return o?.branchId ?? null;
}

/** A sales invoice's default: the order's branch, else the requester's (never the delivery's site — Q-F4). */
export async function defaultInvoiceBranch(db: Db, a: { orderId?: string | null; actorId: string | null }): Promise<string | null> {
  return (await orderBranchId(db, a.orderId)) ?? defaultBranchForActor(db, a.actorId);
}

/** The single branch a set of ids share (every one set and equal), else null. */
export function sharedBranch(ids: (string | null | undefined)[]): string | null {
  if (!ids.length) return null;
  const first = ids[0];
  return first && ids.every((x) => x === first) ? first : null;
}

/** A receipt's default: the branch its order's issued invoices share → the order's → the recorder's. */
export async function defaultCollectionBranch(db: Db, a: { orderId: string | null; recorderId: string | null }): Promise<string | null> {
  if (a.orderId) {
    const inv = await db.salesInvoice.findMany({ where: { orderId: a.orderId, status: "ISSUED", kind: { in: ["INVOICE", "DEBIT_NOTE"] } }, select: { branchId: true } });
    const shared = sharedBranch(inv.map((i) => i.branchId));
    if (shared) return shared;
    const o = await orderBranchId(db, a.orderId);
    if (o) return o;
  }
  return defaultBranchForActor(db, a.recorderId);
}

/** A supplier payment's default: the branch every allocated invoice shares, else null (warned on screen). */
export async function defaultPaymentBranch(db: Db, invoiceIds: string[]): Promise<string | null> {
  if (!invoiceIds.length) return null;
  const rows = await db.supplierInvoice.findMany({ where: { id: { in: invoiceIds } }, select: { branchId: true } });
  return rows.length === invoiceIds.length ? sharedBranch(rows.map((r) => r.branchId)) : null;
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────────

/** A location filter: the branches chosen and whether «غير محدد» is one of them. null = no filter (all). */
export type BranchFilter = { ids: string[]; unassigned: boolean } | null;

/**
 * Pure: the filter from a query — `branch` repeated and / or `branches=a,b,none` (`none` = «غير محدد»). Ids are short
 * tokens; anything else is dropped. Nothing chosen = no filter.
 */
export function parseBranchFilter(params: URLSearchParams): BranchFilter {
  const raw = [...params.getAll("branch"), ...(params.get("branches") ?? "").split(",")].map((s) => s.trim()).filter(Boolean);
  const ok = raw.filter((s) => /^[A-Za-z0-9_\-]{1,64}$/.test(s));
  if (!ok.length) return null;
  return { ids: [...new Set(ok.filter((s) => s !== UNASSIGNED))], unassigned: ok.includes(UNASSIGNED) };
}

export const branchFilterOf = (request: Request): BranchFilter => parseBranchFilter(new URL(request.url).searchParams);

/** Pure: the Prisma `where` of a document's own `branchId` for a filter ({} = all). */
export function branchWhere(f: BranchFilter): { branchId?: { in: string[] } | null; OR?: ({ branchId: { in: string[] } } | { branchId: null })[] } {
  if (!f) return {};
  if (f.unassigned && f.ids.length) return { OR: [{ branchId: { in: f.ids } }, { branchId: null }] };
  if (f.unassigned) return { branchId: null };
  return { branchId: { in: f.ids } };
}

/** The pick list of «الموقع»: the active branches (and the sites mapped to each). */
export async function locationOptions(db: Db = prisma) {
  const rows = await db.finBranch.findMany({
    where: { active: true }, orderBy: { code: "asc" },
    select: { id: true, code: true, nameAr: true, nameEn: true, stockLocations: { where: { isActive: true }, select: { id: true, code: true, nameAr: true, nameEn: true }, orderBy: { sortOrder: "asc" } } },
  });
  return rows.map((b) => ({ id: b.id, code: b.code, nameAr: b.nameAr ?? b.nameEn, nameEn: b.nameEn, sites: b.stockLocations }));
}
