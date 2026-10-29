"use client";
// «فاتورة مشتريات» — the ONE-STEP purchase invoice form and its detail page (unified inventory, phase 2).
//
// Header: supplier (with «+ مورد جديد»), the supplier's invoice number, the invoice date, the due date (proposed from
// the supplier's terms), notes. Lines — each one of:
//   · a stock item of any inventory category (the phase-1 category tree): a green lot («لوط جديد» opens the green lot
//     form, created in the same save) or a material («صنف جديد» with the category preselected); quantity in the
//     item's unit, unit cost before VAT, the VAT category (P-S15 … P-RC15, defaulted from the supplier), the line total;
//   · an earlier receipt not invoiced yet («استلام سابق», the exception path's goods);
//   · an expense (rent, maintenance… — an expense category);
//   · import VAT paid at customs (P-IMP15: the customs value, with the declaration's number and date on the header).
// Actions: «حفظ واستلام» (receive the stock lines + submit the bill, one transaction), «حفظ واستلام واعتماد» (also
// post — only when the SoD setting lets the preparer post), «حفظ كمسودة» (nothing moves). On the detail page: approve,
// return to draft, edit / cancel a received un-posted invoice (its receipts reversed), cancel a posted one (accounts
// payable; the goods stay), the payments. On the phone the line editor is a stack of cards.
// «نقص من المورد» (20261119090000_supplier_shortfall): a stock line's «المستلم أقل من الفاتورة» takes the quantity on the
// supplier's invoice (the line is billed at it; stock takes what arrived) and the treatment — «مطالبة المورد» (default),
// «خسارة» (inventory › adjust + a reason) or, within the weight tolerance, into the cost. The invoice then shows its
// claims, their timeline and the credit note / replacement / abandonment actions (./claims.tsx).
import Link from "next/link";
import { PrintLabelButton } from "@/components/print/QuickPrint";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Notice, OpsLoading } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { Msg, money, todayRiyadh, useApi, useLang, useWrite } from "../../accounting/_ui/shell";
import { BeanForm, emptyForm as emptyBean, type FormState as BeanFormState } from "../../inventory/_parts/bean-form";
import { MaterialForm, type MaterialCategoryOption } from "../../_components/stock-materials";
import { impliedUnitCost, lineNet, lineVatText, plainNumber, sumAmounts } from "@/lib/purchases/amounts";
import { PURCHASE_TAX_INFO, defaultLineTaxCode, isPurchaseTaxCode, lineTaxChoices, mayBillImportVat, type PurchaseLineKind, type PurchaseTaxCode } from "@/lib/purchases/tax-codes";
import { PI_STATUS, type PurchaseCan } from "./invoices";
import { SupplierDialog } from "./suppliers";
import { fmtDate, fmtTime } from "../../employees/_ui/shared";
import { LocationSelect, useLocations } from "../../inventory/_parts/locations";
import { InvoiceClaims, type Claim, type CreditNoteRow } from "./claims";
import { locationName } from "@/lib/inventory/locations";

type Meta = { can: PurchaseCan; sodSelfAllowed: boolean; simpleMode: boolean; viewer: { id: string }; shortfall?: { tolerancePercent: number; abandonReverseVat: boolean } };
type Supplier = { id: string; name: string; vatNumber: string | null; isNonResident?: boolean; kind?: string; paymentTermsDays: number | null };
/** A receipt a landed cost can be added to (the receipts register: any supplier). */
type RegisterReceipt = { id: string; type: string; supplier: { name: string }; purchaseDate: string; quantity: number; reversed: boolean; value: string | null; item: { code: string; name: string; nameAr: string | null; unit: string } | null };
const LANDED_TYPES: [string, string, string][] = [["FREIGHT", "شحن", "Freight"], ["DUTY", "رسوم جمركية", "Customs duty"], ["CLEARANCE", "تخليص جمركي", "Clearance"], ["INSURANCE", "تأمين", "Insurance"]];
/** One row of «سجل النشاط» (the reason, when there is one, is already in the details). */
type Activity = { id: string; at: string; actor: string; label: string; details: string };
type Category = MaterialCategoryOption & { archivedAt?: string | null };
type Expense = { id: string; code: string; nameAr: string; nameEn: string | null; isActive: boolean; account: { code: string; nameAr: string | null; nameEn: string } };
type Green = { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; isActive: boolean };
type Material = { id: string; code: string; name: string; nameAr: string | null; unitOfMeasure: string; categoryId: string | null; isActive: boolean };
type OpenReceipt = { purchaseRecordId: string; supplierId: string; supplierName: string; type: string; date: string; quantity: string; value: string; itemKind: string; itemId: string };
type ServerLine = {
  kind: "GRN" | "STOCK" | "EXPENSE" | "IMPORT_VAT" | "LANDED_COST"; purchaseRecordId: string | null; targetPurchaseRecordId?: string | null; landedCostType?: string | null; stockKind: string | null; stockItemId: string | null; expenseCategoryId: string | null; description: string;
  quantity: string | null; net: string; vatRate: string; vat: string; gross: string; matchedValue: string | null; variance: string | null;
  taxCode: string | null; customsValue: string | null; selfAssessedVat: string | null;
  billedQty?: string | null; shortfallQty?: string | null; shortfallNet?: string | null; shortfallTreatment?: string | null; shortfallReason?: string | null;
  receipt: { id: string; own: boolean; reversed: boolean; quantity: number; costPerUnit: number; date: string } | null;
  item: { stockKind: string; id: string; bean: { serialNumber: string; beanType: string; beanTypeAr: string | null } | null; material: { code: string; name: string; nameAr: string | null; unitOfMeasure: string; categoryId: string | null } | null } | null;
};
type Invoice = {
  id: string; number: string; supplierId: string; supplier: { name: string; vatNumber: string | null }; supplierRef: string; invoiceDate: string; dueDate: string; status: string; notes: string | null;
  customsDeclarationNo: string | null; customsDeclarationDate: string | null; origin: string; receivedDate: string | null; updatedAt: string;
  receivingLocationId?: string | null; receivingLocation?: { id: string; code: string; nameAr: string; nameEn: string | null } | null;
  netTotal: string; vatTotal: string; grossTotal: string; paidTotal: string; creditedTotal?: string; outstanding: string; claims?: Claim[]; creditNotes?: CreditNoteRow[]; createdBy: string; lastEditedBy: string | null; submittedBy: string | null; postedBy: string | null;
  journalEntryId: string | null; received: boolean; reversedReceipts: number; cancelReason: string | null; cancelledAt: string | null; cancelledBy: string | null; lines: ServerLine[];
  allocations: { id: string; amount: string; payment: { number: string; paymentDate: string; status: string } }[];
};
type Lot = { id: string; serialNumber: string; beanType: string; beanTypeAr: string | null; country: string; created: boolean };
type SaveResult = { invoice: Invoice; replayed: boolean; lots: Lot[] };

/** «cat:<id>» a stock category · «GRN» an earlier receipt · «EXPENSE» an expense · «IMPORT» import VAT at customs ·
 *  «LANDED» a landed cost on a receipt (freight, duty, clearance, insurance). */
type Line = {
  key: string; pick: string; stockItemId: string; newLot: BeanFormState | null;
  /** The VAT category; "" = the supplier's default for the line (follows a change of supplier). */
  quantity: string; unitCost: string; taxCode: string; customsValue: string; description: string;
  targetPurchaseRecordId: string; landedCostType: string;
  purchaseRecordId: string; net: string; expenseCategoryId: string;
  /** A received line (editing a received invoice): its receipt and the values it was received with. */
  receipt: { id: string; itemId: string; quantity: string; unitCost: string; reversed?: boolean } | null;
  /** «المستلم أقل من الفاتورة»: the quantity on the supplier's invoice and the treatment ("" = the default / tolerance). */
  short: boolean; billedQty: string; shortTreatment: "" | "CLAIM" | "LOSS"; shortReason: string;
};
let seq = 0;
const blankLine = (pick = ""): Line => ({ key: `l${++seq}`, pick, stockItemId: "", newLot: null, quantity: "", unitCost: "", taxCode: "", customsValue: "", description: "", purchaseRecordId: "", net: "", expenseCategoryId: "", receipt: null, targetPurchaseRecordId: "", landedCostType: "FREIGHT", short: false, billedQty: "", shortTreatment: "", shortReason: "" });
const lineKindOf = (pick: string): PurchaseLineKind => (pick === "EXPENSE" ? "EXPENSE" : pick === "GRN" ? "GRN" : pick === "IMPORT" ? "IMPORT_VAT" : pick === "LANDED" ? "LANDED_COST" : "STOCK");
const UNIT: Record<string, [string, string]> = { KG: ["كغ", "kg"], GRAM: ["غ", "g"], PIECE: ["حبة", "pcs"], UNIT: ["وحدة", "units"], LITER: ["لتر", "L"] };
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const STOCK_TEMPLATES = ["GREEN_COFFEE", "PACKAGING", "GENERAL"];

/** `expense` (Qoyod parity «فواتير بسيطة», `?mode=expense`): a new invoice that starts as ONE expense line — supplier,
 *  date, expense category, VAT and amount — with the stock / landed-cost / import line kinds hidden. Same API, same checks. */
export function PurchaseInvoiceForm({ id, expense = false }: { id: string | null; expense?: boolean }) {
  const { L, lang } = useLang();
  const router = useRouter();
  const sp = useSearchParams();
  const fromReceipt = !id ? sp.get("receipt") : null;
  const meta = useApi<Meta>("/api/purchases/invoices?status=__none__");
  const inv = useApi<Invoice>(id ? `/api/purchases/invoices/${id}` : null);
  const sups = useApi<Supplier[]>("/api/accounting/ap/suppliers");
  const exps = useApi<Expense[]>("/api/accounting/ap/categories");
  const cats = useApi<Category[]>("/api/inventory/categories");
  const greens = useApi<Green[]>("/api/green-beans");
  const mats = useApi<Material[]>("/api/materials");
  const allOpen = useApi<OpenReceipt[]>(fromReceipt ? "/api/accounting/ap/receipts" : null);
  // The receipts a landed cost can name (any supplier, the last 180 days; the register needs the inventory module).
  const register = useApi<RegisterReceipt[]>(`/api/purchases/receipts?from=${addDays(todayRiyadh(), -180)}`);
  const w = useWrite();
  const data = inv.data;
  const can = meta.data?.can;
  const activity = useApi<{ entries: Activity[] }>(id ? `/api/purchases/invoices/${id}/activity?lang=${lang}` : null);
  const [form, setForm] = useState<{ base: Invoice | null | "receipt"; supplierId: string; supplierRef: string; invoiceDate: string; dueDate: string; dueTouched: boolean; notes: string; customsNo: string; customsDate: string; receivedDate: string; locationId?: string; lines: Line[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const { state: locState } = useLocations(false);
  const [dialog, setDialog] = useState<null | "post" | "return" | "cancel" | "cancelPosted">(null);
  const [reason, setReason] = useState("");
  const [beanFor, setBeanFor] = useState<string | null>(null);
  const [matFor, setMatFor] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState(false);
  const [saved, setSaved] = useState<SaveResult | null>(null);

  const categories = useMemo(() => (cats.data ?? []).filter((c) => c.isActive && !c.archivedAt && STOCK_TEMPLATES.includes(c.template)), [cats.data]);
  const catName = (c: Category) => (lang === "ar" ? c.nameAr : c.nameEn || c.nameAr);
  const catPath = (c: Category) => { const p = c.parentId ? (cats.data ?? []).find((x) => x.id === c.parentId) : undefined; return p ? `${catName(p)} › ${catName(c)}` : catName(c); };
  const greenCat = categories.find((c) => c.template === "GREEN_COFFEE");
  const catOf = (pick: string) => (pick.startsWith("cat:") ? categories.find((c) => `cat:${c.id}` === pick) ?? null : null);

  // ── From the invoice on the server (or a receipt to invoice) to the form ─────────────────────────
  function fromInvoice(x: Invoice) {
    return {
      base: x, supplierId: x.supplierId, supplierRef: x.supplierRef, invoiceDate: x.invoiceDate, dueDate: x.dueDate, dueTouched: true, notes: x.notes ?? "",
      customsNo: x.customsDeclarationNo ?? "", customsDate: x.customsDeclarationDate ?? "", receivedDate: x.receivedDate ?? todayRiyadh(), locationId: x.receivingLocationId ?? "",
      lines: x.lines.map((l): Line => {
        const b = blankLine();
        const vatRate = l.taxCode ?? "";
        if (l.kind === "IMPORT_VAT") return { ...b, pick: "IMPORT", taxCode: "P-IMP15", customsValue: l.customsValue ?? "", description: l.description === "—" ? "" : l.description };
        if (l.kind === "LANDED_COST") return { ...b, pick: "LANDED", targetPurchaseRecordId: l.targetPurchaseRecordId ?? "", landedCostType: l.landedCostType ?? "FREIGHT", net: l.net, taxCode: vatRate, description: l.description === "—" ? "" : l.description };
        if (l.kind === "EXPENSE") return { ...b, pick: "EXPENSE", expenseCategoryId: l.expenseCategoryId ?? "", description: l.description === "—" ? "" : l.description, net: l.net, taxCode: vatRate };
        const kind = l.item?.stockKind;
        const catId = kind === "GREEN_BEAN" ? greenCat?.id : l.item?.material?.categoryId;
        const pick = catId ? `cat:${catId}` : "";
        const short = l.billedQty ? { short: true, billedQty: l.billedQty, shortTreatment: (l.shortfallTreatment === "LOSS" ? "LOSS" : "") as Line["shortTreatment"], shortReason: l.shortfallReason ?? "" } : {};
        if (l.kind === "GRN" && l.receipt?.own) {
          const q = String(l.receipt.quantity), u = String(l.receipt.costPerUnit);
          return { ...b, ...short, pick, stockItemId: l.item?.id ?? "", quantity: q, unitCost: u, taxCode: vatRate, description: "", receipt: { id: l.receipt.id, itemId: l.item?.id ?? "", quantity: q, unitCost: u, reversed: l.receipt.reversed } };
        }
        if (l.kind === "GRN") return { ...b, pick: "GRN", purchaseRecordId: l.purchaseRecordId ?? "", net: l.net, taxCode: vatRate, description: "" };
        return { ...b, ...short, pick, stockItemId: l.stockItemId ?? "", quantity: l.quantity ?? "", unitCost: impliedUnitCost(l.net, l.billedQty ?? l.quantity), taxCode: vatRate };
      }),
    };
  }
  const receiptSeed = fromReceipt ? allOpen.data?.find((r) => r.purchaseRecordId === fromReceipt) : undefined;
  const f = form && (form.base === (data ?? null) || (form.base === "receipt" && !data)) ? form
    : data ? fromInvoice(data)
    : receiptSeed ? { base: "receipt" as const, supplierId: receiptSeed.supplierId, supplierRef: "", invoiceDate: todayRiyadh(), dueDate: "", dueTouched: false, notes: "", customsNo: "", customsDate: "", receivedDate: todayRiyadh(), lines: [{ ...blankLine("GRN"), purchaseRecordId: receiptSeed.purchaseRecordId, net: receiptSeed.value }] }
    : { base: null, supplierId: "", supplierRef: "", invoiceDate: todayRiyadh(), dueDate: "", dueTouched: false, notes: "", customsNo: "", customsDate: "", receivedDate: todayRiyadh(), lines: [blankLine(expense ? "EXPENSE" : "")] };
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  const setLine = (key: string, patch: Partial<Line>) => set({ lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const supplier = sups.data?.find((s) => s.id === f.supplierId);
  const dueShown = f.dueTouched ? f.dueDate : f.invoiceDate ? addDays(f.invoiceDate, supplier?.paymentTermsDays ?? 30) : "";
  const receipts = useApi<OpenReceipt[]>(f.supplierId ? `/api/accounting/ap/receipts?supplierId=${f.supplierId}` : null);

  const status = data?.status ?? "NEW";
  const isDraftish = !data || data.status === "DRAFT";
  // SA1: an accounts-payable draft whose STOCK lines only add cost (no goods) is not opened here — it is cancelled and
  // entered again as a purchase invoice (the server refuses it too: LEGACY_STOCK_DRAFT).
  const legacyStock = !!data && data.origin === "AP" && data.status === "DRAFT" && data.lines.some((l) => l.kind === "STOCK");
  const editable = !!can?.draft && !legacyStock && (isDraftish || (editing && data?.status === "SUBMITTED" && data.received));
  const own = !!data && !(meta.data?.sodSelfAllowed || meta.data?.simpleMode) && [data.createdBy, data.lastEditedBy, data.submittedBy].includes(meta.data?.viewer.id ?? "");
  const mayPostOwn = !!can?.ap && !!(meta.data?.sodSelfAllowed || meta.data?.simpleMode);

  // ── Amounts, exactly as the server computes them ─────────────────────────────────────────────
  const isStock = (l: Line) => l.pick.startsWith("cat:");
  // The line's VAT category: chosen, or the supplier's default for the line (as the server defaults it).
  const codeOf = (l: Line): PurchaseTaxCode => {
    const k = lineKindOf(l.pick);
    if (k === "IMPORT_VAT") return "P-IMP15";
    return isPurchaseTaxCode(l.taxCode) && lineTaxChoices(k, supplier).includes(l.taxCode) ? l.taxCode : defaultLineTaxCode(k, supplier);
  };
  // A short line is billed at the supplier's quantity; stock takes the received one.
  const billedOf = (l: Line) => (isStock(l) && l.short && Number(plainNumber(l.billedQty)) > Number(plainNumber(l.quantity)) ? plainNumber(l.billedQty) : null);
  const netOf = (l: Line) => (l.pick === "IMPORT" ? "0.00" : isStock(l) ? lineNet(billedOf(l) ?? l.quantity, l.unitCost) ?? "0.00" : plainNumber(l.net) || "0.00");
  const tolerance = meta.data?.shortfall?.tolerancePercent ?? 0.5;
  /** The shortfall of a short line: quantity, value, % of the billed and the treatment it gets (as the server resolves it). */
  const shortOf = (l: Line) => {
    const billed = billedOf(l);
    if (!billed) return null;
    const qty = Number(billed) - Number(plainNumber(l.quantity));
    // Halalas as integers: the billed and the received values are each rounded once, as the server rounds them.
    const value = (Math.round(Number(lineNet(billed, l.unitCost) ?? 0) * 100) - Math.round(Number(lineNet(l.quantity, l.unitCost) ?? 0) * 100)) / 100;
    const pct = (qty / Number(billed)) * 100;
    const within = pct <= tolerance + 1e-9;
    const treatment = l.shortTreatment === "LOSS" ? "LOSS" : l.shortTreatment === "CLAIM" || !within ? "CLAIM" : "ABSORBED";
    return { qty: Number(qty.toFixed(4)), value, pct, within, treatment };
  };
  // Import VAT: no net, the VAT on the customs value · reverse charge: nothing on the invoice, the VAT self-assessed.
  const calc = f.lines.map((l) => {
    const code = codeOf(l), rate = PURCHASE_TAX_INFO[code].rate, net = netOf(l);
    const vat = code === "P-IMP15" ? lineVatText(plainNumber(l.customsValue) || "0", rate) : code === "P-RC15" ? "0.00" : lineVatText(net, rate);
    const self = code === "P-RC15" ? lineVatText(net, rate) : "0.00";
    return { code, net, vat, self, gross: sumAmounts([net, vat]) };
  });
  const tot = { net: sumAmounts(calc.map((c) => c.net)), vat: sumAmounts(calc.map((c) => c.vat)), gross: sumAmounts(calc.map((c) => c.gross)) };
  const claimable = sumAmounts(calc.map((c) => (c.code === "P-S15-NR" ? "0" : c.vat)));
  const notClaimable = sumAmounts(calc.map((c) => (c.code === "P-S15-NR" ? c.vat : "0")));
  /** What the line debits on approval: its net, plus its VAT when that VAT is not recoverable (capitalised). */
  const costOf = (i: number) => (calc[i].code === "P-S15-NR" ? calc[i].gross : calc[i].net);
  // «نقص من المورد» in the entry preview: the claim and the loss leave the received goods' row.
  const shortTotal = (t: "CLAIM" | "LOSS") => f.lines.reduce((a, l) => { const x = shortOf(l); return a + (x && x.treatment === t ? x.value : 0); }, 0).toFixed(2);
  const selfTotal = sumAmounts(calc.map((c) => c.self));
  const hasImport = f.lines.some((l) => l.pick === "IMPORT");
  const importOk = mayBillImportVat(supplier);
  const registerOf = (id: string) => (register.data ?? []).find((r) => r.id === id);
  const registerLabel = (r: RegisterReceipt) => `${r.purchaseDate.slice(0, 10)} · ${r.supplier.name} · ${r.item ? (lang === "ar" ? r.item.nameAr ?? r.item.name : r.item.name) : r.type} · ${r.quantity}${r.value ? ` · ${money(r.value)}` : ""}`;
  const hasStock = f.lines.some(isStock);
  const receivingSite = f.locationId || locState?.lastReceivingId || locState?.defaultId || "";

  const itemLabel = (l: Line): string => {
    const c = catOf(l.pick);
    if (!c) return "";
    if (c.template === "GREEN_COFFEE") {
      if (l.newLot) return `${L("لوط جديد", "New lot")}: ${l.newLot.serialNumber} · ${lang === "ar" ? l.newLot.beanTypeAr || l.newLot.beanType : l.newLot.beanType}`;
      const g = greens.data?.find((x) => x.id === l.stockItemId);
      return g ? `${g.serialNumber} · ${lang === "ar" ? g.beanTypeAr ?? g.beanType : g.beanType}` : "";
    }
    const m = mats.data?.find((x) => x.id === l.stockItemId);
    return m ? `${lang === "ar" ? m.nameAr ?? m.name : m.name} · ${m.code}` : "";
  };
  const unitOf = (l: Line): string => {
    const c = catOf(l.pick);
    if (!c) return "";
    const u = c.template === "GREEN_COFFEE" ? "KG" : mats.data?.find((x) => x.id === l.stockItemId)?.unitOfMeasure ?? c.defaultUnit;
    const e = UNIT[u ?? ""];
    return e ? (lang === "ar" ? e[0] : e[1]) : "";
  };
  const receiptLabel = (r: OpenReceipt) => {
    const g = r.itemKind === "GREEN_BEAN" ? greens.data?.find((x) => x.id === r.itemId) : undefined;
    const m = r.itemKind === "MATERIAL" ? mats.data?.find((x) => x.id === r.itemId) : undefined;
    const name = g ? (lang === "ar" ? g.beanTypeAr ?? g.beanType : g.beanType) : m ? (lang === "ar" ? m.nameAr ?? m.name : m.name) : "";
    return `${r.date} · ${name} · ${r.quantity} · ${money(r.value)}`;
  };

  const shortPayload = (l: Line) => (billedOf(l) ? { billedQty: billedOf(l), shortfallTreatment: l.shortTreatment || null, shortfallReason: l.shortTreatment === "LOSS" ? l.shortReason.trim() || null : null } : {});
  // ── The payload: a received line unchanged stays its receipt (GRN); a changed one is received again ──────
  const payload = (action: "draft" | "receive" | "post") => ({
    action, supplierId: f.supplierId, supplierRef: f.supplierRef, invoiceDate: f.invoiceDate, dueDate: f.dueTouched ? f.dueDate || null : null, notes: f.notes || null,
    customsDeclarationNo: hasImport ? f.customsNo.trim() || null : null, customsDeclarationDate: hasImport ? f.customsDate || null : null,
    receivedDate: f.receivedDate || null, expectedUpdatedAt: data?.updatedAt ?? null,
    // Phase 3: «موقع الاستلام» — where the goods are received (default: the person's last one, else the default site).
    receivingLocationId: receivingSite || null,
    lines: f.lines.map((l) => {
      const taxCode = codeOf(l), vatRate = String(PURCHASE_TAX_INFO[taxCode].rate);
      if (l.pick === "IMPORT") return { kind: "IMPORT_VAT", customsValue: plainNumber(l.customsValue) || "0", description: l.description || null, taxCode };
      if (l.pick === "LANDED") return { kind: "LANDED_COST", targetPurchaseRecordId: l.targetPurchaseRecordId, landedCostType: l.landedCostType, net: plainNumber(l.net) || "0", vatRate, taxCode, description: l.description || null };
      if (l.pick === "EXPENSE") return { kind: "EXPENSE", expenseCategoryId: l.expenseCategoryId, description: l.description || null, net: plainNumber(l.net) || "0", vatRate, taxCode };
      if (l.pick === "GRN") return { kind: "GRN", purchaseRecordId: l.purchaseRecordId, net: plainNumber(l.net) || null, vatRate, taxCode, description: l.description || null };
      const c = catOf(l.pick);
      const green = c?.template === "GREEN_COFFEE";
      // A received line unchanged (same supplier, item, quantity and unit cost) keeps its receipt.
      if (l.receipt && (!data || data.supplierId === f.supplierId) && l.receipt.itemId === l.stockItemId && l.receipt.quantity === l.quantity && l.receipt.unitCost === l.unitCost) {
        return { kind: "GRN", purchaseRecordId: l.receipt.id, net: lineNet(billedOf(l) ?? l.quantity, l.unitCost), vatRate, taxCode, description: l.description || null, ...shortPayload(l) };
      }
      return { kind: "STOCK", stockKind: green ? "GREEN_BEAN" : "MATERIAL", stockItemId: l.newLot ? null : l.stockItemId, newLot: l.newLot, quantity: plainNumber(l.quantity), unitCost: plainNumber(l.unitCost), vatRate, taxCode, description: l.description || null, ...shortPayload(l) };
    }),
  });

  function check(): string | null {
    if (!f.supplierId) return L("اختر المورد.", "Choose the supplier.");
    if (!f.supplierRef.trim()) return L("أدخل رقم فاتورة المورد.", "Enter the supplier's invoice number.");
    for (const [i, l] of f.lines.entries()) {
      const n = i + 1;
      if (!l.pick) return L(`السطر ${n}: اختر التصنيف أو نوع السطر.`, `Line ${n}: choose the category or the line kind.`);
      if (isStock(l)) {
        if (!l.stockItemId && !l.newLot) return L(`السطر ${n}: اختر الصنف.`, `Line ${n}: choose the item.`);
        if (!(Number(plainNumber(l.quantity)) > 0)) return L(`السطر ${n}: الكمية أكبر من صفر.`, `Line ${n}: the quantity is above zero.`);
        if (!(Number(plainNumber(l.unitCost)) > 0)) return L(`السطر ${n}: تكلفة الوحدة قبل الضريبة أكبر من صفر.`, `Line ${n}: the unit cost before VAT is above zero.`);
        if (l.short && !billedOf(l)) return L(`السطر ${n}: الكمية في فاتورة المورد أكبر من الكمية المستلمة.`, `Line ${n}: the quantity on the supplier's invoice is more than the quantity received.`);
        if (l.short && l.shortTreatment === "LOSS" && l.shortReason.trim().length < 3) return L(`السطر ${n}: سبب الخسارة مطلوب (3 أحرف على الأقل).`, `Line ${n}: the loss needs a reason (3 characters or more).`);
      }
      if (l.pick === "GRN" && !l.purchaseRecordId) return L(`السطر ${n}: اختر الاستلام.`, `Line ${n}: choose the receipt.`);
      if (l.pick === "EXPENSE" && !l.expenseCategoryId) return L(`السطر ${n}: اختر فئة المصروف.`, `Line ${n}: choose the expense category.`);
      if (l.pick === "IMPORT" && !(Number(plainNumber(l.customsValue)) > 0)) return L(`السطر ${n}: أدخل وعاء الضريبة حسب البيان الجمركي (أكبر من صفر).`, `Line ${n}: enter the VAT base per the customs declaration (above zero).`);
      if (l.pick === "IMPORT" && !importOk) return L(`السطر ${n}: ضريبة الاستيراد تُفوتر من الجمارك أو المخلّص الجمركي فقط — غيّر نوع المورد أو احذف السطر.`, `Line ${n}: import VAT is billed by customs or a clearing agent only — change the supplier's kind or remove the line.`);
      if (l.pick === "LANDED" && !l.targetPurchaseRecordId) return L(`السطر ${n}: اختر الاستلام الذي تُضاف إليه التكلفة.`, `Line ${n}: choose the receipt the cost is added to.`);
      if (l.pick === "LANDED" && !(Number(plainNumber(l.net)) > 0)) return L(`السطر ${n}: المبلغ أكبر من صفر.`, `Line ${n}: the amount is above zero.`);
      if (codeOf(l) === "P-S15" && !supplier?.vatNumber) return L(`السطر ${n}: «أساسية 15% · قابلة للاسترداد» تحتاج الرقم الضريبي للمورد. اختر «غير قابلة للاسترداد» أو «خارج النطاق / مورد غير مسجل»، أو أضف رقمه الضريبي.`, `Line ${n}: «Standard 15% · recoverable» needs the supplier's VAT number. Choose «not recoverable» or «out of scope / unregistered supplier», or add its VAT number.`);
    }
    if (hasImport && (!f.customsNo.trim() || !f.customsDate)) return L("ضريبة الاستيراد تحتاج رقم البيان الجمركي وتاريخه.", "Import VAT needs the customs declaration's number and date.");
    return null;
  }

  async function save(action: "draft" | "receive" | "post") {
    const problem = check();
    if (problem) { w.setError(problem); return; }
    const ok = action === "draft" ? L("حُفظت المسودة. لم يتحرك المخزون ولا الحسابات.", "Draft saved. Nothing moved in stock or the books.")
      : action === "post" ? L("استُلمت البضاعة واعتُمدت الفاتورة ورُحّلت.", "Goods received; the invoice is approved and posted.")
      : hasStock ? L("استُلمت البضاعة في المخزون وقُدّمت الفاتورة للاعتماد.", "Goods received into stock; the invoice is submitted for approval.") : L("قُدّمت الفاتورة للاعتماد.", "Submitted for approval.");
    const r = await w.run<SaveResult>(action, id ? `/api/purchases/invoices/${id}` : "/api/purchases/invoices", id ? "PUT" : "POST", payload(action), ok);
    if (!r) return;
    setEditing(false);
    // With green lots received the form stays as it was behind «اطبع الملصق» until the person moves on.
    if (r.lots.length) { setSaved(r); return; }
    setForm(null);
    if (!id) router.replace(`/dashboard/purchases/invoices/${r.invoice.id}`); else { inv.reload(); activity.reload(); }
  }
  function afterLots() {
    const r = saved;
    setSaved(null);
    setForm(null);
    if (!r) return;
    if (!id) router.replace(`/dashboard/purchases/invoices/${r.invoice.id}`); else { inv.reload(); greens.reload(); activity.reload(); }
  }
  async function act(kind: "post" | "return" | "cancel" | "cancelPosted") {
    if (!id) return;
    if (kind === "post") { if (await w.run("post", `/api/accounting/ap/invoices/${id}/post`, "POST", {}, L("اعتُمدت الفاتورة ورُحّلت.", "Approved and posted."))) { setDialog(null); inv.reload(); activity.reload(); } return; }
    if (kind === "return") { if (await w.run("return", `/api/accounting/ap/invoices/${id}/return`, "POST", { reason }, L("أُعيدت للمسودة.", "Returned to draft."))) { setDialog(null); setReason(""); setForm(null); inv.reload(); activity.reload(); } return; }
    if (kind === "cancelPosted") { if (await w.run("cancel", `/api/accounting/ap/invoices/${id}/cancel`, "POST", { reason }, L("أُلغيت الفاتورة وعُكس قيدها؛ البضاعة باقية في المخزون.", "Cancelled and its entry reversed; the goods stay in stock."))) { setDialog(null); setReason(""); inv.reload(); activity.reload(); } return; }
    const r = await w.run<{ cancelled: boolean; number: string; reversedReceipts: number; retiredLots: string[] }>("cancel", `/api/purchases/invoices/${id}/cancel`, "POST", { reason });
    setDialog(null);
    if (!r) return;
    setReason(""); setForm(null); setEditing(false);
    w.setDone(r.reversedReceipts
      ? L(`أُلغيت الفاتورة ${r.number} وعُكس استلامها: رجع المخزون وتكلفته.`, `Invoice ${r.number} cancelled and its receipt reversed: the stock and its cost are back.`)
      : L(`أُلغيت الفاتورة ${r.number}.`, `Invoice ${r.number} cancelled.`));
    inv.reload(); activity.reload();
  }

  if (meta.error && !meta.data) return <Notice tone="danger">{meta.error}</Notice>;
  if (!meta.data || (id && !data && !inv.error) || (fromReceipt && !allOpen.data && !allOpen.error)) return <OpsLoading />;
  if (id && inv.error && !data) return <Notice tone="danger">{inv.error}</Notice>;
  const stInfo = PI_STATUS[status];

  // The plain words under a line's VAT category: what it does, or why it cannot be used.
  function vatHint(l: Line, code: PurchaseTaxCode) {
    const t = code === "P-S15" && supplier && !supplier.vatNumber ? [L("المورد بلا رقم ضريبي: اختر «غير قابلة للاسترداد» أو «خارج النطاق».", "The supplier has no VAT number: choose «not recoverable» or «out of scope»."), true] as const
      : code === "P-S15-NR" ? [L("لا تُسترد: تُضاف إلى تكلفة الصنف أو المصروف.", "Not claimed: added to the item's or expense's cost."), false] as const
      : code === "P-RC15" ? [L("لا ضريبة على فاتورة المورد؛ تُحتسب ذاتيًا مدخلاتٍ ومخرجاتٍ بالمبلغ نفسه.", "No VAT on the supplier's invoice; self-assessed as input and output for the same amount."), false] as const
      : code === "P-IMP15" ? [L("الضريبة على وعاء البيان الجمركي (CIF + الرسوم)، تُدفع للجمارك أو المخلّص.", "VAT on the customs declaration's base (CIF + duty), paid to customs or the clearing agent."), false] as const
      : null;
    if (!t || (!editable && (t[1] || code === "P-IMP15"))) return null;
    return <span className={`pi-vathint${t[1] ? " is-warn" : ""}`} data-testid={`pi-vathint-${f.lines.indexOf(l)}`}>{t[0]}</span>;
  }

  // ── A line, as an editor row (desktop grid) / a card (phone) ─────────────────────────────────
  // A plain render function (not a component): a component declared here would remount on every keystroke.
  function lineEditor(l: Line, i: number) {
    const c = catOf(l.pick);
    const green = c?.template === "GREEN_COFFEE";
    const items = green ? (greens.data ?? []).filter((g) => g.isActive) : c ? (mats.data ?? []).filter((m) => m.isActive && (m.categoryId === c.id || categories.find((x) => x.id === m.categoryId)?.parentId === c.id)) : [];
    const ro = !editable;
    const changedReceipt = l.receipt && (l.receipt.itemId !== l.stockItemId || l.receipt.quantity !== l.quantity || l.receipt.unitCost !== l.unitCost);
    return (
      <div key={l.key} className="pi-line" data-testid={`pi-line-${i}`} role="group" aria-label={L(`السطر ${i + 1}`, `Line ${i + 1}`)}>
        <span className="pi-no"><span className="pi-no-word">{L("السطر", "Line")} </span><bdi>{i + 1}</bdi></span>
        <label className="pi-cell pi-kind"><span className="pi-lbl">{L("التصنيف", "Category")}</span>
          {ro ? <span>{l.pick === "EXPENSE" ? L("مصروف", "Expense") : l.pick === "GRN" ? L("استلام سابق", "Earlier receipt") : l.pick === "IMPORT" ? L("ضريبة استيراد", "Import VAT") : l.pick === "LANDED" ? L("تكلفة إضافية على شحنة", "Landed cost") : c ? catPath(c) : "—"}</span> : (
            <Select value={l.pick} onChange={(e) => setLine(l.key, { ...blankLine(e.target.value), key: l.key, taxCode: e.target.value === "IMPORT" ? "" : l.taxCode, receipt: l.receipt })} placeholder={L("اختر التصنيف", "Choose the category")} data-testid={`pi-kind-${i}`} aria-label={L("التصنيف", "Category")}>
              <option value="">{L("اختر التصنيف", "Choose the category")}</option>
              {categories.map((x) => <option key={x.id} value={`cat:${x.id}`}>{catPath(x)}</option>)}
              <option value="GRN">{L("استلام سابق لم يُفوتر", "Earlier receipt, not invoiced")}</option>
              <option value="EXPENSE">{L("مصروف (إيجار، صيانة…)", "Expense (rent, maintenance…)")}</option>
              <option value="LANDED">{L("تكلفة إضافية على شحنة (شحن، جمارك، تخليص، تأمين)", "Landed cost on a shipment (freight, duty, clearance, insurance)")}</option>
              {importOk ? <option value="IMPORT">{L("استيراد عبر الجمارك (ضريبة الاستيراد)", "Import through customs (import VAT)")}</option> : null}
            </Select>
          )}
        </label>
        <div className="pi-cell pi-item"><span className="pi-lbl">{l.pick === "EXPENSE" ? L("فئة المصروف والبيان", "Expense category and description") : l.pick === "IMPORT" ? L("البيان", "Description") : l.pick === "LANDED" ? L("نوع التكلفة والاستلام", "Cost type and receipt") : L("الصنف", "Item")}</span>
          {l.pick === "LANDED" ? (ro ? <span>{(LANDED_TYPES.find((t) => t[0] === l.landedCostType) ?? LANDED_TYPES[0]).slice(1, 3)[lang === "ar" ? 0 : 1]} · {registerOf(l.targetPurchaseRecordId) ? registerLabel(registerOf(l.targetPurchaseRecordId)!) : data?.lines[i]?.description ?? "—"}</span> : <>
            <Select value={l.landedCostType} onChange={(e) => setLine(l.key, { landedCostType: e.target.value })} data-testid={`pi-landed-type-${i}`} aria-label={L("نوع التكلفة", "Cost type")}>
              {LANDED_TYPES.map((t) => <option key={t[0]} value={t[0]}>{L(t[1], t[2])}</option>)}
            </Select>
            <Select value={l.targetPurchaseRecordId} onChange={(e) => setLine(l.key, { targetPurchaseRecordId: e.target.value })} placeholder={L("الاستلام (أي مورد)", "The receipt (any supplier)")} data-testid={`pi-landed-receipt-${i}`} aria-label={L("الاستلام", "Receipt")}>
              <option value="">{L("الاستلام (أي مورد)", "The receipt (any supplier)")}</option>
              {(register.data ?? []).filter((r) => !r.reversed).map((r) => <option key={r.id} value={r.id}>{registerLabel(r)}</option>)}
            </Select>
          </>) : l.pick === "IMPORT" ? (ro ? <span>{l.description || L("ضريبة استيراد مدفوعة في الجمارك", "Import VAT paid at customs")}</span>
            : <input className="hr-input" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder={L("مثال: ضريبة استيراد شحنة البن عبر المخلّص", "e.g. import VAT on the coffee shipment, via the broker")} aria-label={L("البيان", "Description")} data-testid={`pi-desc-${i}`} />)
          : l.pick === "EXPENSE" ? (ro ? <span>{(() => { const x = exps.data?.find((e) => e.id === l.expenseCategoryId); return x ? (lang === "ar" ? x.nameAr : x.nameEn || x.nameAr) : "—"; })()}{l.description ? ` · ${l.description}` : ""}</span> : <>
            <Select value={l.expenseCategoryId} onChange={(e) => setLine(l.key, { expenseCategoryId: e.target.value })} placeholder={L("فئة المصروف", "Expense category")} data-testid={`pi-expense-${i}`} aria-label={L("فئة المصروف", "Expense category")}>
              <option value="">{L("فئة المصروف", "Expense category")}</option>
              {(exps.data ?? []).filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{`${lang === "ar" ? x.nameAr : x.nameEn || x.nameAr} · ${x.account.code}`}</option>)}
            </Select>
            <input className="hr-input" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder={L("البيان، مثال: إيجار المستودع لشهر نوفمبر", "Description, e.g. warehouse rent for November")} aria-label={L("البيان", "Description")} data-testid={`pi-desc-${i}`} />
          </>) : l.pick === "GRN" ? (ro ? <span>{(receipts.data ?? allOpen.data ?? []).find((r) => r.purchaseRecordId === l.purchaseRecordId) ? receiptLabel((receipts.data ?? allOpen.data ?? []).find((r) => r.purchaseRecordId === l.purchaseRecordId)!) : data?.lines[i]?.description ?? "—"}
            {data?.lines[i]?.matchedValue ? <span className="hr-caption pi-variance" data-testid={`pi-variance-${i}`}>{L("قيمة الاستلام", "Receipt value")} <span className="hr-num">{money(data.lines[i].matchedValue)}</span> · {L("فرق السعر", "Price variance")} <span className="hr-num">{money(data.lines[i].variance)}</span></span> : null}</span> : (
            <Select value={l.purchaseRecordId} onChange={(e) => { const rc = receipts.data?.find((r) => r.purchaseRecordId === e.target.value); setLine(l.key, { purchaseRecordId: e.target.value, net: rc?.value ?? l.net }); }} placeholder={L("اختر الاستلام", "Choose the receipt")} data-testid={`pi-receipt-${i}`} aria-label={L("الاستلام", "Receipt")}>
              <option value="">{L("اختر الاستلام", "Choose the receipt")}</option>
              {(receipts.data ?? []).map((r) => <option key={r.purchaseRecordId} value={r.purchaseRecordId}>{receiptLabel(r)}</option>)}
            </Select>
          )) : c ? (ro ? <span>{itemLabel(l) || data?.lines[i]?.description || "—"}{l.receipt ? (l.receipt.reversed ? <span className="pur-tag is-muted" data-testid={`pi-reversed-${i}`}>{L("استلام معكوس", "Receipt reversed")}</span> : <span className="pur-tag">{L("مستلم", "Received")}</span>) : null}</span> : (
            <span className="pi-itemrow">
              {l.newLot ? <span className="pi-newlot" data-testid={`pi-newlot-${i}`}>{itemLabel(l)} <Btn size="sm" variant="ghost" onClick={() => setBeanFor(l.key)}>{L("تعديل", "Edit")}</Btn></span> : (
                <Select value={l.stockItemId} onChange={(e) => { if (e.target.value === "__new__") { if (green) setBeanFor(l.key); else setMatFor(l.key); return; } setLine(l.key, { stockItemId: e.target.value }); }} placeholder={L("اختر الصنف", "Choose the item")} data-testid={`pi-item-${i}`} aria-label={L("الصنف", "Item")}>
                  <option value="">{L("اختر الصنف", "Choose the item")}</option>
                  {can?.receive ? <option value="__new__">{green ? L("＋ لوط جديد", "＋ New lot") : L("＋ صنف جديد", "＋ New item")}</option> : null}
                  {items.map((x) => <option key={x.id} value={x.id}>{"serialNumber" in x ? `${x.serialNumber} · ${lang === "ar" ? x.beanTypeAr ?? x.beanType : x.beanType}` : `${lang === "ar" ? x.nameAr ?? x.name : x.name} · ${x.code}`}</option>)}
                </Select>
              )}
              {l.receipt ? <span className={`pur-tag${changedReceipt ? " is-warn" : ""}`}>{changedReceipt ? L("سيُعكس ويُستلم من جديد", "Reversed and received again") : L("مستلم", "Received")}</span> : null}
            </span>
          )) : <span className="hr-caption">—</span>}
        </div>
        {isStock(l) ? <>
          <label className="pi-cell pi-qty"><span className="pi-lbl">{L("الكمية", "Quantity")} {unitOf(l) ? `· ${unitOf(l)}` : ""}</span>
            {ro ? <span className="hr-num">{l.quantity} {unitOf(l)}</span> : <input className="hr-input acct-amount" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} placeholder="0" data-testid={`pi-qty-${i}`} aria-label={L("الكمية", "Quantity")} />}
          </label>
          <label className="pi-cell pi-cost"><span className="pi-lbl">{L("تكلفة الوحدة قبل الضريبة", "Unit cost before VAT")}</span>
            {ro ? <span className="hr-num">{money(l.unitCost)}</span> : <input className="hr-input acct-amount" inputMode="decimal" value={l.unitCost} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} placeholder="0.00" data-testid={`pi-cost-${i}`} aria-label={L("تكلفة الوحدة", "Unit cost")} />}
          </label>
        </> : l.pick === "IMPORT" ? (
          <label className="pi-cell pi-amount"><span className="pi-lbl">{L("وعاء الضريبة حسب البيان الجمركي (CIF + الرسوم)", "VAT base per customs declaration (CIF + duty)")}</span>
            {ro ? <span className="hr-num">{money(l.customsValue)}</span> : <input className="hr-input acct-amount" inputMode="decimal" value={l.customsValue} onChange={(e) => setLine(l.key, { customsValue: e.target.value })} placeholder="0.00" data-testid={`pi-customs-value-${i}`} aria-label={L("وعاء الضريبة حسب البيان الجمركي (CIF + الرسوم)", "VAT base per customs declaration (CIF + duty)")} />}
          </label>
        ) : (
          <label className="pi-cell pi-amount"><span className="pi-lbl">{L("المبلغ قبل الضريبة", "Amount before VAT")}</span>
            {ro ? <span className="hr-num">{money(l.net)}</span> : <input className="hr-input acct-amount" inputMode="decimal" value={l.net} onChange={(e) => setLine(l.key, { net: e.target.value })} placeholder="0.00" data-testid={`pi-net-${i}`} aria-label={L("المبلغ", "Amount")} />}
          </label>
        )}
        <label className="pi-cell pi-vat"><span className="pi-lbl">{L("فئة الضريبة", "VAT category")}</span>
          {ro || l.pick === "IMPORT" ? <span data-testid={`pi-vat-ro-${i}`}>{L(PURCHASE_TAX_INFO[calc[i].code].ar, PURCHASE_TAX_INFO[calc[i].code].en)}</span> : (
            <Select value={calc[i].code} onChange={(e) => setLine(l.key, { taxCode: e.target.value })} data-testid={`pi-vat-${i}`} aria-label={L("فئة الضريبة", "VAT category")}>
              {lineTaxChoices(lineKindOf(l.pick), supplier).map((code) => <option key={code} value={code}>{L(PURCHASE_TAX_INFO[code].ar, PURCHASE_TAX_INFO[code].en)}</option>)}
            </Select>
          )}
          {vatHint(l, calc[i].code)}
        </label>
        <div className="pi-cell pi-total"><span className="pi-lbl">{L("الإجمالي", "Total")}</span>
          <strong className="hr-num" data-testid={`pi-total-${i}`}>{money(calc[i]?.gross ?? 0)}</strong>
          <span className="hr-caption hr-num">{L("صافي", "net")} {money(calc[i]?.net ?? 0)} · {L("ضريبة", "VAT")} {money(calc[i]?.vat ?? 0)}{Number(calc[i]?.self) ? <> · {L("محتسبة ذاتيًا", "self-assessed")} {money(calc[i].self)}</> : null}</span>
        </div>
        {editable ? <Btn variant="ghost" size="sm" className="pi-remove" aria-label={L(`حذف السطر ${i + 1}`, `Remove line ${i + 1}`)} title={L("حذف السطر", "Remove line")} disabled={f.lines.length === 1} onClick={() => set({ lines: f.lines.filter((x) => x.key !== l.key) })} data-testid={`pi-remove-${i}`}><span aria-hidden="true">✕</span><span className="pi-remove-word">{L("حذف", "Remove")}</span></Btn> : <span />}
        {isStock(l) ? shortEditor(l, i, ro) : null}
      </div>
    );
  }

  // «المستلم أقل من الفاتورة»: the billed quantity, the shortfall and its treatment, under the line.
  function shortEditor(l: Line, i: number, ro: boolean) {
    const x = shortOf(l);
    const server = data?.lines[i];
    if (ro && !l.short) return null;
    const unit = unitOf(l);
    const tName = (t: string) => (t === "LOSS" ? L("خسارة", "Loss") : t === "ABSORBED" ? L("ضمن حد التسامح — على التكلفة", "Within tolerance — into the cost") : L("مطالبة المورد", "Claim from the supplier"));
    return (
      <div className="pi-short" data-testid={`pi-short-box-${i}`}>
        {ro ? null : (
          <label className="pur-check">
            <input type="checkbox" checked={l.short} onChange={() => setLine(l.key, { short: !l.short, billedQty: l.short ? "" : l.billedQty, shortTreatment: "", shortReason: "" })} data-testid={`pi-short-${i}`} />
            <span>{L("المستلم أقل من الفاتورة", "Received less than billed")}</span>
          </label>
        )}
        {l.short ? <div className="pi-short-row">
          <label className="pi-cell"><span className="pi-lbl is-shown">{L("الكمية في فاتورة المورد", "Quantity on the supplier's invoice")} {unit ? `· ${unit}` : ""}</span>
            {ro ? <span className="hr-num" data-testid={`pi-billed-ro-${i}`}>{l.billedQty} {unit}</span> : <input className="hr-input acct-amount" inputMode="decimal" value={l.billedQty} onChange={(e) => setLine(l.key, { billedQty: e.target.value })} placeholder="0" data-testid={`pi-billed-${i}`} aria-label={L("الكمية في فاتورة المورد", "Quantity on the supplier's invoice")} />}
          </label>
          <label className="pi-cell"><span className="pi-lbl is-shown">{L("معالجة النقص", "Shortfall treatment")}</span>
            {ro ? <span data-testid={`pi-short-treat-ro-${i}`}>{tName(server?.shortfallTreatment ?? x?.treatment ?? "CLAIM")}</span> : (
              <Select value={l.shortTreatment} onChange={(e) => setLine(l.key, { shortTreatment: e.target.value as Line["shortTreatment"] })} data-testid={`pi-short-treat-${i}`} aria-label={L("معالجة النقص", "Shortfall treatment")}>
                <option value="">{x?.within ? L("ضمن حد التسامح — على التكلفة (افتراضي)", "Within tolerance — into the cost (default)") : L("مطالبة المورد (افتراضي)", "Claim from the supplier (default)")}</option>
                {x?.within ? <option value="CLAIM">{L("مطالبة المورد", "Claim from the supplier")}</option> : null}
                {can?.adjust ? <option value="LOSS">{L("خسارة", "Loss")}</option> : null}
              </Select>
            )}
          </label>
          {l.shortTreatment === "LOSS" ? <label className="pi-cell pi-short-reason"><span className="pi-lbl is-shown">{L("سبب الخسارة", "Reason for the loss")} *</span>
            {ro ? <span>{l.shortReason || server?.shortfallReason || "—"}</span> : <input className="hr-input" value={l.shortReason} onChange={(e) => setLine(l.key, { shortReason: e.target.value })} placeholder={L("مثال: تلف أثناء الشحن ولا يعوّض المورد", "e.g. damaged in transit, not covered by the supplier")} data-testid={`pi-short-reason-${i}`} />}
          </label> : null}
          <span className="hr-caption pi-short-hint" data-testid={`pi-short-hint-${i}`}>{x
            ? <>{L("النقص", "Short")} <bdi className="hr-num">{x.qty} {unit}</bdi> · <bdi className="hr-num">{money(x.value)}</bdi> {L("ر.س", "SAR")} · <bdi className="hr-num">{x.pct.toFixed(2)}%</bdi> {L(`(حد التسامح ${tolerance}%)`, `(tolerance ${tolerance}%)`)} · {tName(x.treatment)}{x.treatment === "LOSS" ? L(" — يحتاج «المخزون › تسوية»", " — needs Inventory › Adjust") : ""}</>
            : L("أدخل كمية أكبر من المستلمة.", "Enter more than the quantity received.")}</span>
        </div> : null}
      </div>
    );
  }

  const beanLine = f.lines.find((l) => l.key === beanFor);
  const matLine = f.lines.find((l) => l.key === matFor);
  const matCat = matLine ? catOf(matLine.pick) : null;

  return (
    <div className="acct-split pi-split">
      <div className="hr-stack">
        <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
        {data ? (
          <p className="acct-meta" data-testid="pi-status">
            <span className={`hr-dot tone-${stInfo?.[2] ?? "neutral"}`}><span>{stInfo ? L(stInfo[0], stInfo[1]) : status}</span></span>
            <span className="acct-code">{data.number}</span>
            {data.received ? <span className="pur-tag">{L("استلمت البضاعة", "Goods received")}</span> : null}
            {data.journalEntryId ? <> · <Link href={`/dashboard/accounting/journals/${data.journalEntryId}`}>{L("القيد", "The entry")}</Link></> : null}
          </p>
        ) : null}
        {data?.status === "CANCELLED" ? (
          <div className="pi-cancelled" data-testid="pi-cancelled">
            <strong>{L("ملغاة", "Cancelled")}</strong>
            {data.cancelledAt ? <> · <bdi className="hr-num">{data.cancelledAt.slice(0, 10)}</bdi></> : null}
            <span> · {L("السبب", "Reason")}: <bdi>{data.cancelReason}</bdi></span>
            {data.reversedReceipts ? <span> · {L(`عُكس ${data.reversedReceipts === 1 ? "استلام واحد" : data.reversedReceipts === 2 ? "استلامان" : `${data.reversedReceipts} استلامات`}: رجع المخزون وتكلفته`, `${data.reversedReceipts} receipt${data.reversedReceipts === 1 ? "" : "s"} reversed: the stock and its cost came back`)}</span> : null}
            {data.postedBy ? <span> · {L("عُكس قيدها", "its entry was reversed")}</span> : null}
          </div>
        ) : null}

        {legacyStock ? (
          <div data-testid="pi-legacy-stock"><Notice tone="warning">{L("أُدخلت هذه المسودة عبر واجهة الذمم الدائنة بسطور مخزون تضيف تكلفة فقط (بلا بضاعة مستلمة)، فلا تُفتح هنا للتعديل. ألغها وأدخلها من جديد كفاتورة مشتريات؛ سطر «تكلفة إضافية على شحنة» يضيف التكلفة إلى استلام.", "This draft was entered through the accounts-payable API with stock lines that only add cost (no goods received), so it is not edited here. Cancel it and enter it again as a purchase invoice; a «landed cost» line adds cost to a receipt.")}</Notice></div>
        ) : null}
        <section className="pi-head" aria-label={L("بيانات الفاتورة", "Invoice details")}>
          <label className="hr-field pi-sup"><span className="hr-label">{L("المورد", "Supplier")}{editable ? " *" : ""}</span>
            {editable ? (
              <Select value={f.supplierId} onChange={(e) => { if (e.target.value === "__new__") { setNewSupplier(true); return; } set({ supplierId: e.target.value }); }} placeholder={L("اختر المورد", "Choose the supplier")} data-testid="inv-supplier">
                <option value="">{L("اختر المورد", "Choose the supplier")}</option>
                {can?.suppliers ? <option value="__new__">{L("＋ مورد جديد", "＋ New supplier")}</option> : null}
                {(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            ) : <span className="strong">{data?.supplier.name}</span>}
            <span className="acct-hint">{supplier?.vatNumber ? <>{L("الرقم الضريبي", "VAT no.")} <bdi className="acct-code">{supplier.vatNumber}</bdi></> : L("لا رقم ضريبي مسجّل", "No VAT number on file")}</span>
          </label>
          <label className="hr-field"><span className="hr-label">{L("رقم فاتورة المورد", "Supplier invoice no.")}{editable ? " *" : ""}</span>
            {editable ? <input className="hr-input" dir="ltr" value={f.supplierRef} onChange={(e) => set({ supplierRef: e.target.value })} data-testid="inv-ref" placeholder="INV-2026-0412" /> : <bdi className="acct-code">{f.supplierRef}</bdi>}
            <span className="acct-hint">{L("لا يتكرر للمورد نفسه", "Unique per supplier")}</span>
          </label>
          <label className="hr-field"><span className="hr-label">{L("تاريخ الفاتورة", "Invoice date")}</span>
            {editable ? <input type="date" className="hr-input" value={f.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} data-testid="inv-date" /> : <span className="hr-num">{f.invoiceDate}</span>}
          </label>
          <label className="hr-field"><span className="hr-label">{L("تاريخ الاستحقاق", "Due date")}</span>
            {editable ? <input type="date" className="hr-input" value={dueShown} onChange={(e) => set({ dueDate: e.target.value, dueTouched: true })} data-testid="inv-due" /> : <span className="hr-num">{f.dueDate}</span>}
            <span className="acct-hint">{L(`من شروط المورد: ${supplier?.paymentTermsDays ?? 30} يومًا`, `From the supplier's terms: ${supplier?.paymentTermsDays ?? 30} days`)}</span>
          </label>
          {(editable && hasStock) || data?.receivedDate ? (
            <label className="hr-field"><span className="hr-label">{L("تاريخ الاستلام", "Received on")}</span>
              {editable && hasStock ? <input type="date" className="hr-input" value={f.receivedDate} max={todayRiyadh()} onChange={(e) => set({ receivedDate: e.target.value })} data-testid="inv-received-date" /> : <span className="hr-num">{data?.receivedDate ?? "—"}</span>}
              <span className="acct-hint">{L("يوم دخول البضاعة المخزن — تاريخ الاستلام وحركة التكلفة", "The day the goods came in — the receipt's and cost movement's day")}</span>
            </label>
          ) : null}
          {(editable && hasStock) || data?.receivingLocation ? (
            <label className="hr-field"><span className="hr-label">{L("موقع الاستلام", "Receiving location")}</span>
              {editable && hasStock
                ? <LocationSelect locations={locState?.locations ?? []} value={receivingSite} onChange={(v) => set({ locationId: v })} label={L("موقع الاستلام", "Receiving location")} testId="inv-location" />
                : <span data-testid="inv-location-view">{data?.receivingLocation ? locationName(data.receivingLocation, lang) : "—"}</span>}
              <span className="acct-hint">{L("المكان الذي تدخله البضاعة؛ يمكن تحويلها لاحقًا إلى موقع آخر", "Where the goods come in; they can be transferred to another location later")}</span>
            </label>
          ) : null}
          {hasImport || data?.customsDeclarationNo ? <>
            <label className="hr-field"><span className="hr-label">{L("رقم البيان الجمركي", "Customs declaration no.")}{editable ? " *" : ""}</span>
              {editable ? <input className="hr-input" dir="ltr" value={f.customsNo} onChange={(e) => set({ customsNo: e.target.value })} data-testid="inv-customs-no" placeholder="1234567" /> : <bdi className="acct-code">{f.customsNo || "—"}</bdi>}
            </label>
            <label className="hr-field"><span className="hr-label">{L("تاريخ البيان الجمركي", "Customs declaration date")}{editable ? " *" : ""}</span>
              {editable ? <input type="date" className="hr-input" value={f.customsDate} onChange={(e) => set({ customsDate: e.target.value })} data-testid="inv-customs-date" /> : <span className="hr-num">{f.customsDate || "—"}</span>}
            </label>
          </> : null}
          <label className="hr-field pi-notes"><span className="hr-label">{L("ملاحظات", "Notes")}</span>
            {editable ? <input className="hr-input" value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder={L("اختياري", "Optional")} /> : <span>{f.notes || "—"}</span>}
          </label>
        </section>

        <h2 className="pi-h2">{L("السطور", "Lines")} <span className="acct-hint">{L("الضريبة على كل سطر وتُقرَّب لأقرب هللة", "VAT per line, rounded to the halala")}</span></h2>
        <div className="pi-lines" data-testid="inv-lines">
          <div className="pi-line pi-linehead" aria-hidden="true">
            <span>#</span><span>{L("التصنيف", "Category")}</span><span>{L("الصنف / البيان", "Item / description")}</span><span>{L("الكمية", "Quantity")}</span><span>{L("تكلفة الوحدة", "Unit cost")}</span><span>{L("فئة الضريبة", "VAT category")}</span><span>{L("الإجمالي", "Total")}</span><span />
          </div>
          {f.lines.map((l, i) => lineEditor(l, i))}
        </div>
        {editable && expense && !id ? <div className="acct-actions">
          <Btn size="sm" variant="ghost" onClick={() => set({ lines: [...f.lines, blankLine("EXPENSE")] })} data-testid="inv-add-expense">+ {L("مصروف", "Expense")}</Btn>
        </div> : editable ? <div className="acct-actions">
          <Btn size="sm" onClick={() => set({ lines: [...f.lines, blankLine()] })} data-testid="inv-add-line">+ {L("سطر", "Line")}</Btn>
          {greenCat ? <Btn size="sm" variant="ghost" onClick={() => set({ lines: [...f.lines, blankLine(`cat:${greenCat.id}`)] })}>+ {L("بن أخضر", "Green coffee")}</Btn> : null}
          <Btn size="sm" variant="ghost" onClick={() => set({ lines: [...f.lines, blankLine("EXPENSE")] })} data-testid="inv-add-expense">+ {L("مصروف", "Expense")}</Btn>
          <Btn size="sm" variant="ghost" onClick={() => set({ lines: [...f.lines, blankLine("LANDED")] })} data-testid="inv-add-landed">+ {L("تكلفة إضافية على شحنة", "Landed cost")}</Btn>
          {importOk ? <Btn size="sm" variant="ghost" onClick={() => set({ lines: [...f.lines, blankLine("IMPORT")] })} data-testid="inv-add-import">+ {L("استيراد عبر الجمارك", "Import through customs")}</Btn> : null}
        </div> : null}

        <div className="pi-sum" data-testid="pi-sum">
          <div><span>{L("الصافي", "Net")}</span><strong className="hr-num" data-testid="inv-net-total">{money(tot.net)}</strong></div>
          <div><span>{L("ضريبة القيمة المضافة", "VAT")}</span><strong className="hr-num" data-testid="inv-vat-total">{money(tot.vat)}</strong></div>
          {claimable !== tot.vat ? <div><span>{L("منها لا تُسترد", "Of which not claimable")}</span><strong className="hr-num" data-testid="inv-vat-nr">{money(notClaimable)}</strong></div> : null}
          {Number(selfTotal) ? <div><span>{L("احتساب عكسي (مدخلات = مخرجات)", "Reverse charge (input = output)")}</span><strong className="hr-num" data-testid="inv-vat-rc">{money(selfTotal)}</strong></div> : null}
          <div className="is-grand"><span>{L("الإجمالي (ر.س)", "Total (SAR)")}</span><strong className="hr-num" data-testid="inv-gross-total">{money(tot.gross)}</strong></div>
          {data?.status === "POSTED" ? <>
            <div><span>{L("المدفوع", "Paid")}</span><strong className="hr-num">{money(data.paidTotal)}</strong></div>
            {Number(data.creditedTotal ?? 0) ? <div><span>{L("إشعارات دائنة من المورد", "Supplier credit notes")}</span><strong className="hr-num" data-testid="pi-credited">{money(data.creditedTotal)}</strong></div> : null}
            <div><span>{L("المتبقي", "Remaining")}</span><strong className="hr-num" data-testid="pi-outstanding">{money(data.outstanding)}</strong></div>
          </> : null}
        </div>

        <div className="acct-actions pi-actions" data-testid="pi-actions">
          {editable ? <>
            <Btn variant="primary" busy={w.busy === "receive"} disabled={!!w.busy || (hasStock && !can?.receive)} onClick={() => save("receive")} data-testid="pi-receive">{hasStock || data?.received ? L("حفظ واستلام", "Save and receive") : L("حفظ وتقديم للاعتماد", "Save and submit")}</Btn>
            {mayPostOwn ? <Btn busy={w.busy === "post"} disabled={!!w.busy || (hasStock && !can?.receive)} onClick={() => save("post")} data-testid="pi-receive-post">{hasStock || data?.received ? L("حفظ واستلام واعتماد", "Save, receive and approve") : L("حفظ واعتماد", "Save and approve")}</Btn> : null}
            {!data?.received ? <Btn variant="ghost" busy={w.busy === "draft"} disabled={!!w.busy} onClick={() => save("draft")} data-testid="pi-save-draft">{L("حفظ كمسودة", "Save as draft")}</Btn> : null}
            {editing ? <Btn variant="ghost" onClick={() => { setEditing(false); setForm(null); }}>{L("تراجع عن التعديل", "Discard changes")}</Btn> : null}
            {!id ? <Link className="hr-btn is-ghost" href="/dashboard/purchases?tab=invoices">{L("إلغاء", "Cancel")}</Link> : null}
          </> : null}
          {data && !editable && data.status === "SUBMITTED" && can?.ap ? <>
            <Btn variant="primary" disabled={own} onClick={() => setDialog("post")} data-testid="inv-post">{L("اعتماد وترحيل", "Approve and post")}</Btn>
            {/* SA2: an invoice that received its goods is not returned to draft — its preparer edits or cancels it. */}
            {!data.received ? <Btn onClick={() => setDialog("return")} data-testid="pi-return">{L("إعادة للمسودة", "Return to draft")}</Btn> : null}
          </> : null}
          {data && !editable && data.received && (data.status === "SUBMITTED" || data.status === "DRAFT") && can?.draft && can.receive && can.changeReceived ? <>
            {data.status === "SUBMITTED" ? <Btn onClick={() => setEditing(true)} data-testid="pi-edit">{L("تعديل", "Edit")}</Btn> : null}
          </> : null}
          {data && data.received && (data.status === "SUBMITTED" || data.status === "DRAFT") && can?.draft && can.receive && can.changeReceived ? <Btn variant="danger" onClick={() => setDialog("cancel")} data-testid="pi-cancel">{L("إلغاء الفاتورة والاستلام", "Cancel the invoice and the receipt")}</Btn> : null}
          {data && !data.received && data.status === "DRAFT" && can?.draft ? <Btn variant="ghost" onClick={() => setDialog("cancel")} data-testid="pi-cancel-draft">{L("إلغاء المسودة", "Cancel the draft")}</Btn> : null}
          {data && data.status === "POSTED" && can?.ap && Number(data.paidTotal) === 0 && !(data.claims ?? []).some((c) => c.settlements.some((s) => !s.voidedAt)) ? <Btn variant="danger" onClick={() => setDialog("cancelPosted")} data-testid="inv-cancel">{L("إلغاء الفاتورة", "Cancel the invoice")}</Btn> : null}
          {data && data.status === "POSTED" && can?.ap && Number(data.outstanding) > 0 ? <Link className="hr-btn" href="/dashboard/accounting/ap?view=payments">{L("تسجيل سداد", "Record a payment")}</Link> : null}
        </div>
        {own && data?.status === "SUBMITTED" ? <p className="acct-hint" data-testid="pi-sod-note">{L("أدخلت هذه الفاتورة أو عدّلتها أو قدّمتها؛ يعتمدها محاسب آخر (فصل المهام).", "You entered, edited or submitted this invoice; another accountant approves it (segregation of duties).")}</p> : null}
        {data?.status === "SUBMITTED" && !can?.ap ? <p className="acct-hint">{L("بانتظار اعتماد محاسب الذمم الدائنة.", "Waiting for an accounts payable approver.")}</p> : null}
        {editable && hasStock && !can?.receive ? <Notice tone="info">{L("استلام البضاعة يحتاج صلاحية «المخزون › استلام»؛ احفظها مسودة ليستلمها أمين المخزون.", "Receiving the goods needs Inventory › Receive; save a draft for the storekeeper to receive.")}</Notice> : null}
        {data?.status === "POSTED" && data.received ? <p className="acct-hint">{L("البضاعة المستلمة بهذه الفاتورة تبقى في المخزون بعد الاعتماد؛ مرتجع المورد يأتي في مرحلة لاحقة.", "The goods this invoice received stay in stock once it is approved; supplier returns come in a later phase.")}</p> : null}
        {data && data.received && (data.status === "SUBMITTED" || data.status === "DRAFT") && can?.draft && !can.changeReceived ? <p className="acct-hint" data-testid="pi-change-note">{L("تعديل أو إلغاء فاتورة مستلمة يحتاج صلاحية «المشتريات › إلغاء/تعديل فاتورة مستلمة».", "Editing or cancelling a received invoice needs Purchases › Cancel or edit a received purchase invoice.")}</p> : null}
        {data?.allocations.length ? <p className="acct-hint">{L("السداد", "Payments")}: {data.allocations.map((a) => `${a.payment.number} (${money(a.amount)}${a.payment.status === "VOIDED" ? L(" — ملغى", " — voided") : ""})`).join("، ")}</p> : null}

        {data ? <InvoiceClaims invoice={data} claims={data.claims ?? []} creditNotes={data.creditNotes ?? []} can={{ ap: can?.ap, receive: can?.receive, adjust: can?.adjust }} settings={meta.data?.shortfall ?? null}
          onChanged={(m) => { w.setDone(m); inv.reload(); activity.reload(); }} /> : null}
        {id ? (
          <section aria-labelledby="pi-activity-h" data-testid="pi-activity">
            <h2 className="pi-h2" id="pi-activity-h">{L("سجل النشاط", "Activity")} <span className="acct-hint">{L("من فعل ماذا ومتى — يظهر أيضًا في سجل التدقيق", "Who did what and when — also in the audit log")}</span></h2>
            {activity.error && !activity.data ? <p className="acct-hint">{activity.error}</p> : !activity.data ? <p className="acct-hint">{L("جارٍ التحميل…", "Loading…")}</p> : !activity.data.entries.length ? <p className="acct-hint">{L("لا نشاط مسجّل بعد.", "No activity recorded yet.")}</p> : (
              <ol className="pi-activity">
                {[...activity.data.entries].reverse().map((e) => (
                  <li key={e.id} data-testid="pi-activity-row">
                    <span className="pi-act-what">{e.label}</span>
                    <span className="pi-act-who"><bdi>{e.actor}</bdi> · <time dateTime={e.at}><bdi>{fmtDate(e.at, lang)}</bdi> <bdi className="hr-num">{fmtTime(e.at)}</bdi></time></span>
                    {e.details ? <span className="pi-act-detail">{e.details}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}
      </div>

      <aside className="acct-card pi-aside" aria-label={L("أثر الفاتورة", "What the invoice does")} data-testid="inv-preview">
        <h3>{data?.received && !editable ? L("استلمت هذه الفاتورة", "This invoice received") : L("عند «حفظ واستلام»", "On «Save and receive»")}</h3>
        <ul className="pi-effects">
          {f.lines.filter(isStock).map((l) => <li key={l.key}><span>{itemLabel(l) || L("صنف", "Item")}</span><span className="hr-num">+{l.quantity || 0} {unitOf(l)}</span></li>)}
          {!hasStock ? <li className="hr-caption">{L("لا أصناف مخزون في هذه الفاتورة.", "No stock items on this invoice.")}</li> : null}
        </ul>
        <h3>{L("القيد عند الاعتماد", "The entry on approval")}</h3>
        <table className="hr-table is-dense">
          <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th></tr></thead>
          <tbody>
            {f.lines.some((l) => l.pick === "LANDED") ? <tr><td>{L("المخزون · تكلفة إضافية (الجزء المستهلك ← فروقات المخزون)", "Inventory · landed cost (the consumed share → inventory variance)")}</td><td className="num hr-num">{money(sumAmounts(f.lines.map((l, i) => (l.pick === "LANDED" ? costOf(i) : "0"))))}</td><td /></tr> : null}
            {f.lines.some((l) => isStock(l) || l.pick === "GRN") ? <tr><td>{L("بضاعة مستلمة لم تصل فاتورتها", "Goods received not invoiced")}</td><td className="num hr-num">{money(((Math.round(Number(sumAmounts(f.lines.map((l, i) => (isStock(l) || l.pick === "GRN" ? costOf(i) : "0")))) * 100) - Math.round(Number(shortTotal("CLAIM")) * 100) - Math.round(Number(shortTotal("LOSS")) * 100)) / 100).toFixed(2))}</td><td /></tr> : null}
            {Number(shortTotal("CLAIM")) ? <tr data-testid="inv-preview-claims"><td>{L("مطالبات الموردين", "Supplier claims")}</td><td className="num hr-num">{money(shortTotal("CLAIM"))}</td><td /></tr> : null}
            {Number(shortTotal("LOSS")) ? <tr data-testid="inv-preview-loss"><td>{L("خسائر نقص المشتريات", "Purchase shortage losses")}</td><td className="num hr-num">{money(shortTotal("LOSS"))}</td><td /></tr> : null}
            {f.lines.map((l, i) => { if (l.pick !== "EXPENSE") return null; const x = exps.data?.find((e) => e.id === l.expenseCategoryId); return <tr key={l.key}><td>{x ? `${x.account.code} ${lang === "ar" ? x.account.nameAr ?? x.account.nameEn : x.account.nameEn}` : L("حساب المصروف", "Expense account")}</td><td className="num hr-num">{money(costOf(i))}</td><td /></tr>; })}
            {Number(claimable) || Number(selfTotal) ? <tr><td>{L("ضريبة المدخلات", "VAT input")}</td><td className="num hr-num">{money(sumAmounts([claimable, selfTotal]))}</td><td /></tr> : null}
            {Number(selfTotal) ? <tr><td>{L("ضريبة المخرجات · احتساب عكسي", "VAT output · reverse charge")}</td><td /><td className="num hr-num">{money(selfTotal)}</td></tr> : null}
            <tr><td>{L("ذمم دائنة", "Accounts payable")} · {supplier?.name ?? data?.supplier.name ?? "—"}</td><td /><td className="num hr-num">{money(tot.gross)}</td></tr>
            <tr className="is-total"><td>{L("المجموع", "Total")}</td><td className="num hr-num">{money(sumAmounts([tot.gross, selfTotal]))}</td><td className="num hr-num">{money(sumAmounts([tot.gross, selfTotal]))}</td></tr>
          </tbody>
        </table>
        <p className="acct-hint">{L("الاستلام يقيّد المخزون مقابل «بضاعة مستلمة لم تصل فاتورتها» بنفس مبلغ السطر، فلا فرق سعر عند الاعتماد. قبل تفعيل المحاسبة تتحرك تكلفة المخزون ولا يُرحَّل قيد.", "Receiving books inventory against «goods received not invoiced» at the line's amount, so approval carries no price variance. Before accounting is activated the stock cost moves and no entry posts.")}</p>
      </aside>

      <Dialog open={!!dialog} onClose={() => setDialog(null)} testId="pi-dialog"
        title={dialog === "post" ? L("اعتماد الفاتورة وترحيلها", "Approve and post") : dialog === "return" ? L("إعادة الفاتورة للمسودة", "Return to draft") : dialog === "cancel" ? L("إلغاء الفاتورة والاستلام", "Cancel the invoice and the receipt") : L("إلغاء الفاتورة المعتمدة", "Cancel the approved invoice")}
        actions={<><Btn onClick={() => setDialog(null)}>{L("رجوع", "Back")}</Btn><Btn variant={dialog === "post" ? "primary" : "danger"} busy={!!w.busy} disabled={dialog !== "post" && reason.trim().length < 3} onClick={() => dialog && act(dialog)} data-testid="inv-confirm">{L("تأكيد", "Confirm")}</Btn></>}>
        {dialog === "post" ? <p>{L(`يُرحَّل قيد بإجمالي ${money(data?.grossTotal)} ر.س على حساب المورد ${data?.supplier.name ?? ""}. لا يُعدَّل بعد ذلك؛ التصحيح بالإلغاء.`, `An entry of SAR ${money(data?.grossTotal)} posts to ${data?.supplier.name ?? ""}. It is not edited afterwards; a correction is a cancellation.`)}</p> : <>
          {dialog === "cancel" ? <p>{L("تُعكس استلامات هذه الفاتورة (يرجع المخزون وتكلفته وقيد الاستلام) وتبقى الفاتورة «ملغاة» برقمها وسببها، في عملية واحدة. يُرفض إن استُخدمت البضاعة بعد استلامها.", "This invoice's receipts are reversed (stock, its cost and the receipt entry come back) and the invoice stays, «Cancelled», with its number and reason — in one step. Refused if the goods were used since.")}</p> : null}
          {dialog === "cancelPosted" ? <p>{L("يُعكس قيد الفاتورة وتبقى البضاعة المستلمة في المخزون (تعود «بضاعة مستلمة لم تصل فاتورتها»). مرتجع المورد في مرحلة لاحقة.", "The invoice's entry is reversed and the received goods stay in stock (back to «goods received not invoiced»). Supplier returns come later.")}</p> : null}
          <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="inv-reason" /></label>
        </>}
      </Dialog>

      {saved ? (
        <Dialog open title={L("استُلمت البضاعة", "Goods received")} onClose={afterLots} testId="pi-label-prompt"
          sub={<><span className="acct-code">{saved.invoice.number}</span> · {PI_STATUS[saved.invoice.status] ? L(PI_STATUS[saved.invoice.status][0], PI_STATUS[saved.invoice.status][1]) : saved.invoice.status}</>}
          actions={<Btn variant="primary" onClick={afterLots} data-testid="pi-label-done">{L("متابعة إلى الفاتورة", "Continue to the invoice")}</Btn>}>
          <p style={{ margin: 0 }}>{L("اطبع ملصق كل لوت بن أخضر استُلم — ملصق مرقّم لكل كيس، بباركود يُمسح عند الجرد والتحميص:", "Print the label of each green lot received — one numbered label per sack, with a barcode scanned at counts and roasting:")}</p>
          <ul className="pi-lots">
            {saved.lots.map((lot) => (
              <li key={lot.id}>
                <span><strong>{lang === "ar" ? lot.beanTypeAr ?? lot.beanType : lot.beanType}</strong> · <bdi className="acct-code">{lot.serialNumber}</bdi>{lot.created ? <span className="pur-tag">{L("لوط جديد", "New lot")}</span> : null}</span>
                <PrintLabelButton template="GREEN_LOT" label={L("اطبع الملصق", "Print label")} testId={`pi-print-label-${lot.serialNumber}`}
                  subtitle={`${lang === "ar" ? lot.beanTypeAr ?? lot.beanType : lot.beanType} · ${lot.serialNumber}`}
                  items={[{ kind: "green", greenBeanId: lot.id, label: `${lang === "ar" ? lot.beanTypeAr ?? lot.beanType : lot.beanType} · ${lot.serialNumber}`, perSack: true }]} />
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}

      {beanLine ? (
        <BeanForm title={L("لوط بن أخضر جديد", "New green coffee lot")} initial={beanLine.newLot ?? emptyBean()} hideQuantity saveLabel={L("إضافة إلى الفاتورة", "Add to the invoice")} saving={false}
          onClose={() => setBeanFor(null)} onSave={async (b) => { setLine(beanLine.key, { newLot: b, stockItemId: "" }); setBeanFor(null); }} />
      ) : null}
      {matLine && matCat ? (
        <MaterialForm category={matCat} categories={categories} noOpening onClose={() => setMatFor(null)} onError={() => undefined}
          onSaved={(m) => { setMatFor(null); mats.reload(); setLine(matLine.key, { stockItemId: m.id }); }} />
      ) : null}
      {newSupplier && can ? (
        <SupplierDialog initial={null} can={can} onClose={() => setNewSupplier(false)}
          onSaved={(s) => { setNewSupplier(false); sups.reload(); set({ supplierId: s.id }); }} />
      ) : null}
    </div>
  );
}
