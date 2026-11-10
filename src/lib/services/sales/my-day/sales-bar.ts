// «يومي» D11 — the sales bar (owner-approved Figma 1JbZgpMqmPkUVne8ms9Ozz page 1843:2, notes 1861:898). Pure rules, so the
// arithmetic is asserted directly (tests/sales/unit/sales-bar.test.ts); the rows come from loadMyDay's existing reads.
//
// ONE bar, two layers, against the month's SalesTarget:
//   · COLLECTED (solid, the headline) — RECORDED CollectionEvents attributed by attributeCollections (accountant receipts
//     included, decision 6): the commission engine's number and the performance page's targetPercent.
//   · SALES (light) — Σ taxableTotal of ISSUED INVOICE + DEBIT_NOTE − ISSUED CREDIT_NOTE by issueDate in the Riyadh month
//     (a note in its own month), drafts excluded; a document belongs to the earliest deal link of its order, else to its
//     quotation's deal, split by the deal's CURRENT shares (owner decision 4).
// Stages run on COLLECTED only: 0→100 %, then 100→120, 120→150, then full above 150 (no 80 % marker). Sales never open a
// stage nor make the target «met» (state D). The end label shows the next stage's bonus, read from the plan's targetBonus
// brackets — never hardcoded.
import { Decimal, ZERO, roundMoney } from "@/lib/services/commissions/engine";
import { bonusBracket, type Components } from "@/lib/services/commissions/builder";

/** The stage boundaries, in percent of the target. */
export const STAGE_BOUNDS = [0, 100, 120, 150] as const;

export type Stage = {
  /** 0: 0→100 · 1: 100→120 · 2: 120→150 · 3: above 150 (the bar is full, no stage after). */
  index: 0 | 1 | 2 | 3;
  from: number;
  to: number | null;
};

/** The stage a collected amount stands in — exact (no rounded percent): 99.99 % is still stage 0, 100 % is stage 1. */
export function stageOf(collected: Decimal, target: Decimal): Stage {
  const reached = (p: number) => collected.times(100).greaterThanOrEqualTo(target.times(p));
  if (reached(150)) return { index: 3, from: 150, to: null };
  if (reached(120)) return { index: 2, from: 120, to: 150 };
  if (reached(100)) return { index: 1, from: 100, to: 120 };
  return { index: 0, from: 0, to: 100 };
}

/** A layer's width inside the stage: (value % − from) ÷ (to − from), clamped to 0…1; full above the last stage. */
export function layerWidth(value: Decimal, target: Decimal, stage: Stage): number {
  if (stage.to === null || target.lessThanOrEqualTo(0)) return 1;
  const pct = Number(value.times(100).dividedBy(target));
  return Math.max(0, Math.min(1, (pct - stage.from) / (stage.to - stage.from)));
}

export type StageBonus = { kind: "FIXED" | "DISCRETIONARY"; amount: string | null } | null;

/** The bonus the plan pays on reaching `percent` of the target (its targetBonus bracket), or null (none / no plan). */
export function bonusAt(components: Components | null, percent: number): StageBonus {
  if (!components) return null;
  const T = new Decimal(100);
  const hit = bonusBracket(components, new Decimal(percent), T);
  if (!hit || hit.kind === "NONE") return null;
  return hit.kind === "FIXED" ? { kind: "FIXED", amount: hit.planAmount.toFixed(2) } : { kind: "DISCRETIONARY", amount: null };
}

export type BarState = {
  stage: Stage;
  collectedPct: string;
  salesPct: string;
  collectedWidth: number;
  salesWidth: number;
  /** Where the month says you should be today, as a fraction of the stage — null when it falls outside the stage. */
  pace: number | null;
  /** The next stage's start: «باقي تحصّل X ⃁ وتاخذ مكافأة Y»; null above 150 %. */
  next: { percent: number; remaining: string; perDay: string | null; bonus: StageBonus } | null;
  /** The bonus of the highest stage reached (stage ≥ 1), for «فيها مكافأة الهدف …». */
  reachedBonus: StageBonus;
  /** State D: invoiced the target (sales ≥ 100 %) while collected is still under it — no celebration, a warning. */
  invoicedNotCollected: boolean;
};

const pct1 = (n: Decimal, d: Decimal) => n.times(100).dividedBy(d).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);

export function barState(input: {
  target: Decimal; collected: Decimal; sales: Decimal; daysLeft: number; monthDays: number; components: Components | null;
}): BarState {
  const { target, collected, sales, daysLeft, monthDays, components } = input;
  const stage = stageOf(collected, target);
  const pacePct = ((monthDays - daysLeft) / monthDays) * 100;
  const pace = stage.to !== null && pacePct >= stage.from && pacePct < stage.to ? (pacePct - stage.from) / (stage.to - stage.from) : null;
  let next: BarState["next"] = null;
  if (stage.to !== null) {
    const remaining = roundMoney(Decimal.max(ZERO, target.times(stage.to).dividedBy(100).minus(collected)));
    next = {
      percent: stage.to, remaining: remaining.toFixed(2),
      perDay: daysLeft > 0 ? remaining.dividedBy(daysLeft).toDecimalPlaces(0, Decimal.ROUND_CEIL).toFixed(0) : null,
      bonus: bonusAt(components, stage.to),
    };
  }
  return {
    stage,
    collectedPct: pct1(collected, target),
    salesPct: pct1(sales, target),
    collectedWidth: layerWidth(collected, target, stage),
    salesWidth: layerWidth(sales, target, stage),
    pace,
    next,
    reachedBonus: stage.index >= 1 ? bonusAt(components, stage.from) : null,
    invoicedNotCollected: stage.index === 0 && sales.times(100).greaterThanOrEqualTo(target.times(100)),
  };
}

// ─── Documents: sales, owed, drafts ──────────────────────────────────────────────────────────────────────────────

export type Share = { employeeId: string; sharePercent: string | number };
/** The rep's CURRENT share of a deal (owner decision 4): its OpportunityOwner rows as they stand, else the owner's 100 %. */
export function currentShare(deal: { ownerId: string; owners: Share[] | null }, employeeId: string): Decimal {
  const rows = deal.owners ?? [];
  if (rows.length === 0) return deal.ownerId === employeeId ? new Decimal(100) : ZERO;
  const mine = rows.find((r) => r.employeeId === employeeId);
  return mine ? new Decimal(String(mine.sharePercent)) : ZERO;
}

export type DocRow = {
  id: string; kind: string; status: string; number: string | null; customerId: string;
  customerName: string | null; customerNameAr: string | null; customerPhone: string | null;
  issueDate: string | null; taxableTotal: string; grandTotal: string;
  /** Σ APPLIED ArApplications on the document (receipts and credit notes). */
  applied: string;
  /** Its issued credit notes' part still unapplied anywhere (net of notes, never counted twice with an application). */
  notesOpen: string;
  inMonth: boolean;
  /** Drafts: whether the order is live and not held on a discount (PENDING / REJECTED). */
  draftLive: boolean;
  dealOwnerId: string; owners: Share[] | null;
};

/** Σ before-VAT sales of the month for the rep (issued invoices and debit notes − credit notes), at the current share. */
export function salesOf(docs: DocRow[], employeeId: string): Decimal {
  let total = ZERO;
  for (const d of docs) {
    if (d.status !== "ISSUED" || !d.inMonth) continue;
    const sign = d.kind === "CREDIT_NOTE" ? -1 : d.kind === "INVOICE" || d.kind === "DEBIT_NOTE" ? 1 : 0;
    if (!sign) continue;
    const share = currentShare({ ownerId: d.dealOwnerId, owners: d.owners }, employeeId);
    total = total.plus(roundMoney(new Decimal(d.taxableTotal).times(share).dividedBy(100)).times(sign));
  }
  return roundMoney(total);
}

/** What one issued invoice / debit note still owes, VAT included: total − its notes' open part − applications, ≥ 0. */
export function openOfDoc(d: Pick<DocRow, "grandTotal" | "applied" | "notesOpen">): Decimal {
  const open = new Decimal(d.grandTotal).minus(d.notesOpen).minus(d.applied);
  return open.isNegative() ? ZERO : roundMoney(open);
}

export type OwedCustomer = {
  customerId: string; name: string; nameAr: string | null; phone: string | null;
  /** The rep's share, before VAT / with VAT. */
  net: string; gross: string;
  /** The customer's whole open amount before VAT, and the rep's share of it in percent (whole number) — < 100 = shared. */
  fullNet: string; sharePct: number;
  invoices: number; oldestDays: number;
};

/**
 * «عند العملاء»: the issued invoices (and debit notes) of the rep's deals still open — per INVOICE, through ArApplication
 * (never a deal-level «paid»), before VAT by each document's own ratio, at the rep's CURRENT share (as sales and collected
 * are), plus the VAT-inclusive total and the count. Per customer, the whole amount too, so a shared deal can say so.
 */
/** `monthNet`: the part of `net` on invoices issued this month (D13: «كل الأشهر · منها X من هالشهر»). */
export function owedOf(docs: DocRow[], today: string, employeeId: string): { net: string; gross: string; invoices: number; monthNet: string; customers: OwedCustomer[] } {
  type Acc = { c: Omit<OwedCustomer, "net" | "gross" | "fullNet" | "sharePct" | "oldestDays">; net: Decimal; gross: Decimal; full: Decimal; oldest: string };
  const by = new Map<string, Acc>();
  let net = ZERO, gross = ZERO, count = 0, monthNet = ZERO;
  for (const d of docs) {
    if (d.status !== "ISSUED" || (d.kind !== "INVOICE" && d.kind !== "DEBIT_NOTE")) continue;
    const open = openOfDoc(d);
    if (open.lessThanOrEqualTo(0)) continue;
    const share = currentShare({ ownerId: d.dealOwnerId, owners: d.owners }, employeeId);
    if (share.lessThanOrEqualTo(0)) continue;
    const g = new Decimal(d.grandTotal);
    const fullNet = g.isZero() ? ZERO : roundMoney(open.times(d.taxableTotal).dividedBy(g));
    const n = roundMoney(fullNet.times(share).dividedBy(100));
    const gr = roundMoney(open.times(share).dividedBy(100));
    net = net.plus(n); gross = gross.plus(gr); count++;
    if (d.inMonth) monthNet = monthNet.plus(n);
    const a = by.get(d.customerId) ?? { c: { customerId: d.customerId, name: d.customerName ?? "", nameAr: d.customerNameAr, phone: d.customerPhone, invoices: 0 }, net: ZERO, gross: ZERO, full: ZERO, oldest: d.issueDate ?? today };
    a.net = a.net.plus(n); a.gross = a.gross.plus(gr); a.full = a.full.plus(fullNet); a.c.invoices++;
    if (d.issueDate && d.issueDate < a.oldest) a.oldest = d.issueDate;
    by.set(d.customerId, a);
  }
  const days = (from: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
  const customers = [...by.values()]
    .map((a): OwedCustomer => ({
      ...a.c, net: roundMoney(a.net).toFixed(2), gross: roundMoney(a.gross).toFixed(2), fullNet: roundMoney(a.full).toFixed(2),
      sharePct: a.full.isZero() ? 100 : Math.min(100, Math.round(Number(a.net.times(100).dividedBy(a.full)))),
      oldestDays: days(a.oldest),
    }))
    .sort((x, y) => y.oldestDays - x.oldestDays || Number(y.net) - Number(x.net));
  return { net: roundMoney(net).toFixed(2), gross: roundMoney(gross).toFixed(2), invoices: count, monthNet: roundMoney(monthNet).toFixed(2), customers };
}

/**
 * «بانتظار المحاسب»: draft invoices of live orders on the rep's deals, before VAT (a held direct sale is not waiting), at
 * the rep's CURRENT share like sales, owed and collected (gate L2); a deal the rep holds no share of is skipped.
 */
export function draftsOf(docs: DocRow[], employeeId: string): { amount: string; count: number } {
  let amount = ZERO, count = 0;
  for (const d of docs) {
    if (d.status !== "DRAFT" || d.kind !== "INVOICE" || !d.draftLive) continue;
    const share = currentShare({ ownerId: d.dealOwnerId, owners: d.owners }, employeeId);
    if (share.lessThanOrEqualTo(0)) continue;
    amount = amount.plus(roundMoney(new Decimal(d.taxableTotal).times(share).dividedBy(100))); count++;
  }
  return { amount: roundMoney(amount).toFixed(2), count };
}

// ─── Breakdown of collected (sheet F) ────────────────────────────────────────────────────────────────────────────

export type EventParts = {
  /** The rep's attributed, before-VAT amount of the event (exactly what attributeCollections adds for them). */
  mine: Decimal;
  gross: Decimal;
  /** VAT-inclusive money of the receipt applied to invoices issued this month / before it (current applications). */
  fromMonth: Decimal;
  fromBefore: Decimal;
  /** An accountant receipt's event: all of it paid invoices (decision 6) — its parts are scaled to its (capped) amount. */
  accountant: boolean;
};

/**
 * «من فواتير الشهر» / «من فواتير قبل» / «دفعات مقدمة»: each event's attributed amount split by where its receipt's money
 * went (SalesCollection → ArApplication → invoice.issueDate), so the before-VAT conversion follows each event's own ratio.
 * The advance is the remainder, per event: the three always add up to collected exactly.
 */
export function breakdownOf(events: EventParts[]): { fromMonth: string; fromBefore: string; advances: string; total: string } {
  let m = ZERO, b = ZERO, a = ZERO;
  for (const e of events) {
    if (e.mine.isZero()) continue;
    if (e.gross.lessThanOrEqualTo(0)) { a = a.plus(e.mine); continue; }
    let gm: Decimal, gb: Decimal;
    if (e.accountant) {
      const applied = e.fromMonth.plus(e.fromBefore);
      if (applied.isZero()) { gm = ZERO; gb = ZERO; } else { gm = e.gross.times(e.fromMonth).dividedBy(applied); gb = e.gross.minus(gm); }
    } else {
      gm = Decimal.min(e.fromMonth, e.gross);
      gb = Decimal.min(e.fromBefore, e.gross.minus(gm));
    }
    // Cumulative rounding (gate L1): this month, then this month + earlier, the advance last — no part below zero and
    // the three add up to the event's amount exactly.
    const pm = roundMoney(e.mine.times(gm).dividedBy(e.gross));
    const pb = Decimal.max(ZERO, roundMoney(e.mine.times(gm.plus(gb)).dividedBy(e.gross)).minus(pm));
    m = m.plus(pm); b = b.plus(pb); a = a.plus(Decimal.max(ZERO, e.mine.minus(pm).minus(pb)));
  }
  return { fromMonth: m.toFixed(2), fromBefore: b.toFixed(2), advances: a.toFixed(2), total: m.plus(b).plus(a).toFixed(2) };
}
