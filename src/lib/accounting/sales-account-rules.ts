// Sales account rules — the accountant's request: revenue and cost of sales by SALES ACTIVITY, then by product.
//   The same SKU is sold by the roastery (B2B), the web shop and the café, and each activity has its own revenue and
//   cost-of-sales accounts. A rule names an activity and, optionally, ONE of a product category or a SKU. For a line of
//   a document whose activity is known, each of the two accounts is resolved on its own, most specific first:
//     (activity, SKU) → (activity, the SKU's category) → (activity) → the general posting role (SALES_REVENUE / COGS).
//   A document with no recorded activity uses the general role, exactly as before: an activity is never guessed.
// The rules are read ONLY at the moment an entry is posted. The posted line keeps the account it was posted to, the
// activity and how the account was chosen (JournalEntryLine.accountId / salesActivity / accountBasis); changing a rule
// later changes no posted line, and no report recomputes an account from the rules.
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";

type Tx = Prisma.TransactionClient;
export const SALES_ACTIVITIES = ["ROASTERY_B2B", "WEBSITE", "CAFE"] as const;
export type SalesActivity = (typeof SALES_ACTIVITIES)[number];
export const isSalesActivity = (v: unknown): v is SalesActivity => typeof v === "string" && (SALES_ACTIVITIES as readonly string[]).includes(v);
/** A request's `salesActivity`: undefined = not given, null = cleared; anything else must be one of the three. */
export function parseSalesActivity(v: unknown): SalesActivity | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isSalesActivity(v)) throw refuse("BAD_INPUT", "salesActivity is ROASTERY_B2B, WEBSITE or CAFE.");
  return v;
}

/**
 * «تفعيل النشاط» — an activity is offered to users and accepted on a NEW document only once it is ACTIVATED, by name,
 * in the deployment's settings: SALES_ACTIVITIES_ENABLED="CAFE,WEBSITE". The owner sets it after the activity's rules
 * are approved; a rule existing does not activate anything, and nothing is activated by default (unset = none). An
 * unknown word activates nothing. This gates what may be RECORDED; a document that already carries an activity keeps
 * it and is posted by its rules as before. Pure: reads the environment only.
 */
export function enabledSalesActivities(env: Record<string, string | undefined> = process.env): SalesActivity[] {
  const named = new Set((env.SALES_ACTIVITIES_ENABLED ?? "").split(",").map((x) => x.trim()));
  return SALES_ACTIVITIES.filter((a) => named.has(a));
}
/**
 * The `salesActivity` a request may record: undefined = not given, null = none. A value that is not one of the three is
 * refused (BAD_INPUT), and one that is not activated is refused (SALES_ACTIVITY_NOT_ACTIVE) — never dropped in
 * silence, never turned into «no activity». `current`: the activity the document already carries, which it may keep.
 */
export function usableSalesActivity(v: unknown, o: { current?: string | null; env?: Record<string, string | undefined> } = {}): SalesActivity | null | undefined {
  const a = parseSalesActivity(v);
  if (a && a !== o.current && !enabledSalesActivities(o.env).includes(a)) throw refuse("SALES_ACTIVITY_NOT_ACTIVE");
  return a;
}

export type RuleBasis = "ACTIVITY_SKU" | "ACTIVITY_CATEGORY" | "ACTIVITY";
export type RuledAccount = { accountId: string; basis: RuleBasis };
export type RuledAccounts = { revenue: RuledAccount | null; cogs: RuledAccount | null };
const NONE: RuledAccounts = { revenue: null, cogs: null };
type RuleRow = { categoryId: string | null; productSkuId: string | null; revenueAccountId: string | null; cogsAccountId: string | null };

/** Pure: the accounts of one line from the rules of ITS activity (most specific first; each account on its own). */
export function pickRuledAccounts(rules: RuleRow[], line: { skuId?: string | null; categoryId?: string | null }): RuledAccounts {
  const tiers: [RuleBasis, RuleRow | undefined][] = [
    ["ACTIVITY_SKU", line.skuId ? rules.find((r) => r.productSkuId === line.skuId) : undefined],
    ["ACTIVITY_CATEGORY", line.categoryId ? rules.find((r) => !r.productSkuId && r.categoryId === line.categoryId) : undefined],
    ["ACTIVITY", rules.find((r) => !r.productSkuId && !r.categoryId)],
  ];
  const of = (f: "revenueAccountId" | "cogsAccountId"): RuledAccount | null => {
    for (const [basis, r] of tiers) if (r?.[f]) return { accountId: r[f] as string, basis };
    return null;
  };
  return { revenue: of("revenueAccountId"), cogs: of("cogsAccountId") };
}

/** What the rules of ONE activity give a line: its accounts, the category it was looked up under, and whether it needs a review. */
export type LineRuling = RuledAccounts & { categoryId: string | null; /** No rule of its SKU or category gives the revenue account. */ revenueUnmapped: boolean; /** The same, for the cost-of-sales account. */ cogsUnmapped: boolean };
export type SalesRuleContext = {
  /** The activity is recorded and may be looked up. */
  active: boolean;
  /** The activity keeps accounts by category or SKU: its own default account is then no substitute for classifying a line. */
  detailRequired: boolean;
  forLine: (l: { skuId?: string | null; categoryId?: string | null; productId?: string | null }) => LineRuling;
};
const NO_CONTEXT: SalesRuleContext = { active: false, detailRequired: false, forLine: () => ({ ...NONE, categoryId: null, revenueUnmapped: false, cogsUnmapped: false }) };

/**
 * The rules of one activity, ready to rule on lines. A line's category is its own (`categoryId`, a line that is not a
 * SKU of the system), else the category of its SKU's product, else of the product itself.
 * `revenueUnmapped`: no rule gives the revenue account, or only the activity's default does while the activity keeps
 * accounts by category / SKU — such a line is shown for review; it is never sent to a general account in silence.
 */
export async function salesRuleContext(tx: Tx, a: { activity: string | null | undefined; skuIds?: (string | null | undefined)[]; productIds?: (string | null | undefined)[] }): Promise<SalesRuleContext> {
  if (!isSalesActivity(a.activity)) return NO_CONTEXT;
  const rules = await tx.salesAccountRule.findMany({ where: { tenantId: "hiqbah", activity: a.activity }, select: { categoryId: true, productSkuId: true, revenueAccountId: true, cogsAccountId: true } });
  const skuIds = [...new Set((a.skuIds ?? []).filter((x): x is string => !!x))];
  const productIds = [...new Set((a.productIds ?? []).filter((x): x is string => !!x))];
  const skus = skuIds.length ? await tx.productSKU.findMany({ where: { id: { in: skuIds } }, select: { id: true, product: { select: { categoryId: true } } } }) : [];
  const products = productIds.length ? await tx.coffeeProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, categoryId: true } }) : [];
  const catOfSku = new Map(skus.map((s) => [s.id, s.product?.categoryId ?? null]));
  const catOfProduct = new Map(products.map((p) => [p.id, p.categoryId]));
  const detailRequired = rules.some((r) => r.categoryId || r.productSkuId);
  return {
    active: true, detailRequired,
    forLine: (l) => {
      const categoryId = l.categoryId ?? (l.skuId ? catOfSku.get(l.skuId) ?? null : null) ?? (l.productId ? catOfProduct.get(l.productId) ?? null : null);
      const picked = pickRuledAccounts(rules, { skuId: l.skuId ?? null, categoryId });
      const unmapped = (a: RuledAccount | null) => !a || (a.basis === "ACTIVITY" && detailRequired);
      return { ...picked, categoryId, revenueUnmapped: unmapped(picked.revenue), cogsUnmapped: unmapped(picked.cogs) };
    },
  };
}

/** The ruled accounts of these SKUs / products (a lot that names a product and no SKU) for one activity. Null activity → none. */
export async function resolveSalesAccounts(tx: Tx, a: { activity: string | null | undefined; skuIds?: (string | null | undefined)[]; productIds?: (string | null | undefined)[] }): Promise<{ sku: (id: string | null | undefined) => LineRuling; product: (id: string | null | undefined) => LineRuling }> {
  const c = await salesRuleContext(tx, a);
  return { sku: (id) => c.forLine({ skuId: id ?? null }), product: (id) => c.forLine({ productId: id ?? null }) };
}

/**
 * A draft's line in the review: give it a sales category (`salesCategoryId`, null clears it), OR record the decision
 * that it posts to the general account (`generalAccountReason`) — who, when and why stay on the line, and the posted
 * line says so (accountBasis …_DECISION). A new category clears an earlier decision. Only on a DRAFT: the line of an
 * issued document never changes (sinv_line_guard), so no posted document is touched.
 */
export async function classifyDraftLine(lineId: unknown, input: { salesCategoryId?: unknown; generalAccountReason?: unknown }, ctx: AuditContext) {
  if (typeof lineId !== "string" || !lineId) throw refuse("BAD_INPUT", "lineId.");
  const hasCategory = input.salesCategoryId !== undefined, hasDecision = input.generalAccountReason !== undefined;
  if (hasCategory === hasDecision) throw refuse("BAD_INPUT", "Give salesCategoryId or generalAccountReason (one of them).");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const line = await tx.salesInvoiceLine.findUnique({ where: { id: lineId }, select: { id: true, invoiceId: true } });
    if (!line) throw refuse("NOT_FOUND");
    const inv = await tx.$queryRaw<{ status: string; kind: string }[]>`SELECT "status", "kind" FROM "SalesInvoice" WHERE "id" = ${line.invoiceId} FOR UPDATE`;
    if (inv[0]?.status !== "DRAFT") throw refuse("SALES_LINE_NOT_DRAFT");
    if (hasCategory) {
      const v = input.salesCategoryId;
      if (v !== null && v !== "" && (typeof v !== "string" || v.length > 60)) throw refuse("BAD_INPUT", "salesCategoryId.");
      const categoryId = v ? (v as string) : null;
      if (categoryId && !(await tx.catalogCategory.findUnique({ where: { id: categoryId }, select: { id: true } }))) throw refuse("NOT_FOUND");
      return tx.salesInvoiceLine.update({ where: { id: lineId }, data: { salesCategoryId: categoryId, generalAccountBy: null, generalAccountAt: null, generalAccountReason: null, generalAccountActivity: null }, select: { id: true, salesCategoryId: true, generalAccountAt: true } });
    }
    const reason = cleanReason(input.generalAccountReason);
    if (!reason) throw refuse("BAD_INPUT", "generalAccountReason: 5–300 characters.");
    // The decision is made for the activity the document is posted under NOW; under another activity it no longer holds.
    const activity = await documentSalesActivity(tx, line.invoiceId);
    if (!activity) throw refuse("BAD_INPUT", "The document has no sales activity: there is nothing to decide.");
    return tx.salesInvoiceLine.update({ where: { id: lineId }, data: { generalAccountBy: ctx.actorId, generalAccountAt: new Date(), generalAccountReason: reason, generalAccountActivity: activity }, select: { id: true, salesCategoryId: true, generalAccountAt: true } });
  }, TX_OPTS);
}

const cleanReason = (v: unknown): string | null => {
  const r = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return r.length >= 5 && r.length <= 300 ? r : null;
};

/**
 * The sales activity a document is posted with: a note takes the activity its ORIGINAL was posted with (the snapshot
 * on the original's lines), so a return lands in the activity of its sale; otherwise its order's, or — with no
 * order — the document's own. Null when none is recorded — the general accounts then apply and the line carries no activity (never a guess).
 */
export async function documentSalesActivity(tx: Tx, invoiceId: string): Promise<SalesActivity | null> {
  const doc = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { salesActivity: true, orderId: true, originalInvoiceId: true } });
  if (!doc) return null;
  if (doc.originalInvoiceId) {
    const original = await tx.journalEntry.findFirst({ where: { sourceType: "SALES_INVOICE", sourceId: doc.originalInvoiceId, sourceEvent: "ISSUED" }, select: { lines: { where: { salesActivity: { not: null } }, select: { salesActivity: true }, take: 1 } } });
    // The original is posted: its lines are the record — an original posted with no activity gives a note with none.
    if (original) return isSalesActivity(original.lines[0]?.salesActivity) ? original.lines[0].salesActivity : null;
    const orig = await tx.salesInvoice.findUnique({ where: { id: doc.originalInvoiceId }, select: { salesActivity: true, orderId: true } });
    if (orig) return ownActivity(tx, orig);
  }
  return ownActivity(tx, doc);
}
async function ownActivity(tx: Tx, d: { salesActivity: string | null; orderId: string | null }): Promise<SalesActivity | null> {
  // An order's invoice takes the ORDER's activity (its cost of sales is posted from the order's deliveries — one
  // activity for the revenue and its cost); only an invoice with no order carries its own.
  const a = d.orderId ? (await tx.order.findUnique({ where: { id: d.orderId }, select: { salesActivity: true } }))?.salesActivity ?? null : d.salesActivity;
  return isSalesActivity(a) ? a : null;
}

/**
 * The recorded decision that the cost of sales of ONE order line posts to a general account, although no rule of its
 * SKU or category gives a cost-of-sales account in the order's activity. Made for the activity the order has now: it
 * holds only while the order keeps it. Recorded with who, when and why, and audited by the database.
 */
export async function recordCostAccountDecision(orderItemId: unknown, reasonIn: unknown, ctx: AuditContext) {
  if (typeof orderItemId !== "string" || !orderItemId) throw refuse("BAD_INPUT", "orderItemId.");
  const reason = cleanReason(reasonIn);
  if (!reason) throw refuse("BAD_INPUT", "costAccountReason: 5–300 characters.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, select: { id: true, order: { select: { salesActivity: true } } } });
    if (!item) throw refuse("NOT_FOUND");
    const activity = item.order.salesActivity;
    if (!isSalesActivity(activity)) throw refuse("BAD_INPUT", "The order has no sales activity: there is nothing to decide.");
    const data = { activity, decidedBy: ctx.actorId, decidedAt: new Date(), reason };
    return tx.costAccountDecision.upsert({ where: { orderItemId }, create: { orderItemId, ...data }, update: data, select: { orderItemId: true, activity: true, decidedBy: true, decidedAt: true } });
  }, TX_OPTS);
}

/**
 * The review list for cost of sales: open order lines of orders posted under an activity that keeps accounts by
 * category or SKU, whose SKU no rule gives a cost-of-sales account, and that carry no decision for that activity.
 * A delivery of such a line that draws a real cost is refused until a rule or a decision exists.
 */
export async function unmappedOrderCostLines() {
  const items = await prisma.orderItem.findMany({
    where: { productSkuId: { not: null }, order: { salesActivity: { not: null }, status: { notIn: ["Cancelled"] } } },
    orderBy: { createdAt: "desc" }, take: 500,
    select: { id: true, beanTypeName: true, quantityUnits: true, deliveredUnits: true, quantityKg: true, deliveredQty: true, productSkuId: true, productSku: { select: { skuCode: true } }, order: { select: { id: true, orderNumber: true, salesActivity: true, customer: { select: { name: true, nameAr: true } } } } },
  });
  const open = items.filter((i) => (i.quantityUnits != null ? (i.deliveredUnits ?? 0) < i.quantityUnits : (i.deliveredQty ?? 0) < i.quantityKg));
  if (!open.length) return [];
  const decisions = new Map((await prisma.costAccountDecision.findMany({ where: { orderItemId: { in: open.map((i) => i.id) } }, select: { orderItemId: true, activity: true } })).map((d) => [d.orderItemId, d.activity]));
  const out: { orderItemId: string; orderNumber: number; customer: string; activity: string; skuCode: string | null; name: string; categoryId: string | null }[] = [];
  const byActivity = new Map<string, typeof open>();
  for (const i of open) byActivity.set(i.order.salesActivity!, [...(byActivity.get(i.order.salesActivity!) ?? []), i]);
  for (const [activity, list] of byActivity) {
    const c = await prisma.$transaction((tx) => salesRuleContext(tx, { activity, skuIds: list.map((i) => i.productSkuId) }));
    for (const i of list) {
      const r = c.forLine({ skuId: i.productSkuId });
      if (!r.cogsUnmapped || decisions.get(i.id) === activity) continue;
      out.push({ orderItemId: i.id, orderNumber: i.order.orderNumber, customer: i.order.customer?.nameAr || i.order.customer?.name || "", activity, skuCode: i.productSku?.skuCode ?? null, name: i.beanTypeName, categoryId: r.categoryId });
    }
  }
  return out;
}

const WANT = { revenueAccountId: "REVENUE", cogsAccountId: "EXPENSE" } as const;

/**
 * Set the rule of one scope — (activity), (activity, category) or (activity, SKU). A field left out is left as it is;
 * null clears it; a rule left with neither account is removed. The account must be an active postable leaf, not a
 * control account, of the right type: revenue → a revenue account, cost of sales → an expense account.
 * Every change is recorded by the database (ledger_audit_row on "SalesAccountRule").
 */
export async function setSalesAccountRule(scope: { activity: unknown; categoryId?: unknown; productSkuId?: unknown }, input: { revenueAccountId?: unknown; cogsAccountId?: unknown }, ctx: AuditContext) {
  if (!isSalesActivity(scope?.activity)) throw refuse("BAD_INPUT", "activity is ROASTERY_B2B, WEBSITE or CAFE.");
  const idOf = (v: unknown, name: string): string | null => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || v.length > 60) throw refuse("BAD_INPUT", `${name}.`);
    return v;
  };
  const categoryId = idOf(scope.categoryId, "categoryId");
  const productSkuId = idOf(scope.productSkuId, "productSkuId");
  if (categoryId && productSkuId) throw refuse("BAD_INPUT", "A rule names a category or a SKU, not both.");
  const activity = scope.activity;
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const data: { revenueAccountId?: string | null; cogsAccountId?: string | null } = {};
    for (const field of ["revenueAccountId", "cogsAccountId"] as const) {
      const v = input[field];
      if (v === undefined) continue;
      if (v === null || v === "") { data[field] = null; continue; }
      if (typeof v !== "string") throw refuse("BAD_INPUT", `${field}.`);
      const acc = await tx.account.findUnique({ where: { id: v }, select: { code: true, type: true, isActive: true, allowPosting: true, controlType: true, _count: { select: { children: true } } } });
      if (!acc) throw refuse("ACCOUNT_NOT_FOUND");
      if (!acc.isActive || !acc.allowPosting || acc._count.children > 0 || acc.controlType) throw refuse("ACCOUNT_NOT_POSTABLE", `(${acc.code})`, `(${acc.code})`);
      if (String(acc.type) !== WANT[field]) throw refuse("ROLE_TYPE", `(${field} → ${acc.code}: a ${WANT[field].toLowerCase()} account is required)`, `(${acc.code}: ${field === "revenueAccountId" ? "المطلوب حساب إيرادات" : "المطلوب حساب مصروفات (تكلفة مبيعات)"})`);
      data[field] = v;
    }
    if (!Object.keys(data).length) throw refuse("BAD_INPUT", "Nothing to change.");
    if (categoryId && !(await tx.catalogCategory.findUnique({ where: { id: categoryId }, select: { id: true } }))) throw refuse("NOT_FOUND");
    if (productSkuId && !(await tx.productSKU.findUnique({ where: { id: productSkuId }, select: { id: true } }))) throw refuse("NOT_FOUND");
    // One rule per scope (the unique index over the scope is the database's word; the lock orders two writers).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales-account-rule:${activity}:${categoryId ?? ""}:${productSkuId ?? ""}`}, 0))`;
    const cur = await tx.salesAccountRule.findFirst({ where: { tenantId: "hiqbah", activity, categoryId, productSkuId }, select: { id: true, revenueAccountId: true, cogsAccountId: true } });
    const next = { revenueAccountId: data.revenueAccountId !== undefined ? data.revenueAccountId : cur?.revenueAccountId ?? null, cogsAccountId: data.cogsAccountId !== undefined ? data.cogsAccountId : cur?.cogsAccountId ?? null };
    const out = { activity, categoryId, productSkuId, ...next };
    if (!next.revenueAccountId && !next.cogsAccountId) {
      if (cur) await tx.salesAccountRule.delete({ where: { id: cur.id } });
      return { ...out, removed: true };
    }
    if (cur) await tx.salesAccountRule.update({ where: { id: cur.id }, data: { ...next, updatedBy: ctx.actorId } });
    else await tx.salesAccountRule.create({ data: { activity, categoryId, productSkuId, ...next, updatedBy: ctx.actorId } });
    return { ...out, removed: false };
  }, TX_OPTS);
}

/** The settings screen: the rules by activity, the general accounts, and what to choose from. */
export async function listSalesAccountRules() {
  const acc = { select: { id: true, code: true, referenceCode: true, nameAr: true, nameEn: true } } as const;
  const [rules, roles, categories, skus] = await Promise.all([
    prisma.salesAccountRule.findMany({ where: { tenantId: "hiqbah" }, orderBy: [{ activity: "asc" }, { createdAt: "asc" }], select: { id: true, activity: true, updatedAt: true, revenueAccount: acc, cogsAccount: acc, category: { select: { id: true, nameAr: true, nameEn: true } }, productSku: { select: { id: true, skuCode: true, name: true, nameAr: true } } } }),
    prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: ["SALES_REVENUE", "COGS"] } }, select: { role: true, account: acc } }),
    prisma.catalogCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { nameAr: "asc" }], select: { id: true, nameAr: true, nameEn: true, isActive: true } }),
    prisma.productSKU.findMany({ orderBy: { skuCode: "asc" }, select: { id: true, skuCode: true, name: true, nameAr: true, isActive: true, product: { select: { productNameAr: true, productNameEn: true, categoryId: true } } } }),
  ]);
  const role = (r: string) => roles.find((x) => x.role === r)?.account ?? null;
  return {
    activities: SALES_ACTIVITIES, enabled: enabledSalesActivities(),
    general: { revenue: role("SALES_REVENUE"), cogs: role("COGS") },
    rules: rules.map((r) => ({
      id: r.id, activity: r.activity, scope: r.productSku ? "SKU" as const : r.category ? "CATEGORY" as const : "ACTIVITY" as const,
      category: r.category, sku: r.productSku ? { id: r.productSku.id, skuCode: r.productSku.skuCode, name: r.productSku.nameAr || r.productSku.name } : null,
      revenueAccount: r.revenueAccount, cogsAccount: r.cogsAccount, updatedAt: r.updatedAt,
    })),
    categories,
    skus: skus.map((s) => ({ id: s.id, skuCode: s.skuCode, name: s.nameAr || s.name || s.product.productNameAr || s.product.productNameEn, isActive: s.isActive, categoryId: s.product.categoryId })),
  };
}
