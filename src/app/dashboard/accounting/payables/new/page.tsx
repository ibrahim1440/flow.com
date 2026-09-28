"use client";

// Figma: ACC-21. Supplier bill editor: supplier with VAT-number check, lines with tax category,
// live totals computed exactly like the server (half-up per line), journal preview, save as
// draft or save and submit. ?edit=<id> edits a draft.
// Stage 4b: a Bill / Credit note switch (?creditFor=<billId> starts a credit note for that bill).
// A supplier credit note credits one posted bill of the same supplier, with a reason; its lines are
// an expense credit, goods returned (settles a posted supplier return) or a price reduction on a
// posted receipt line (traced through stock, production and sales).
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, X } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Field, INPUT, Notice, Segmented, Table, Td, Th, useL } from "../../../finance/_components/ui";
import { riyadhToday, useCan } from "../../_components/kit";
import { lineMinor } from "../../_components/bill-math";

type Supplier = { id: string; name: string; vatNumber: string | null; paymentTermsDays: number; active: boolean };
type Account = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; allowPosting: boolean; isActive: boolean; controlKind: string; roles: string[] };
type Tax = { id: string; code: string; nameAr: string | null; nameEn: string; rate: string; isActive: boolean; isDefault: boolean };
type Dim = { id: string; code: string; nameAr: string | null; nameEn: string };
type LineKind = "EXPENSE" | "STOCK_RECEIPT" | "STOCK_RETURN" | "STOCK_PRICE_ADJUSTMENT";
type Line = { kind: LineKind; accountId: string; description: string; quantity: string; unitPrice: string; taxCategoryId: string; costCenterId: string; invDocumentId: string; invDocLineId: string };
type DocKind = "BILL" | "CREDIT_NOTE";
/** Rows of GET /api/accounting/bills (kind is read when the list returns it). */
type BillRow = { id: string; billNo: number; supplierInvoiceNo: string; billDate: string; totalGross: string; status: string; kind?: DocKind };
type Original = { id: string; billNo: number; kind: DocKind; status: string; supplierId: string; supplierInvoiceNo: string; totalGross: string; creditable: string | null };
type ReturnDoc = { id: string; docNo: number; docDate: string; value: string | null; supplierId: string | null; lines: { name: string; qty: string; unit: string }[] };
type ReceiptLine = { id: string; docNo: number; date: string; item: string; baseUnit: string; qty: string; value: string; qtyLeft: string };

const blank = (tax = ""): Line => ({ kind: "EXPENSE", accountId: "", description: "", quantity: "1", unitPrice: "", taxCategoryId: tax, costCenterId: "", invDocumentId: "", invDocLineId: "" });
const vatOk = (v: string | null) => !!v && /^3\d{13}3$/.test(v);
const STOCK = new Set<LineKind>(["STOCK_RECEIPT", "STOCK_RETURN", "STOCK_PRICE_ADJUSTMENT"]);
const PICK: Record<string, LineKind> = { __stock: "STOCK_RECEIPT", __return: "STOCK_RETURN", __price: "STOCK_PRICE_ADJUSTMENT" };

export default function NewBillPage() {
  const { L, money } = useL();
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get("edit");
  const creditFor = sp.get("creditFor");
  const { can } = useCan();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [dims, setDims] = useState<{ branches: Dim[]; costCenters: Dim[] }>({ branches: [], costCenters: [] });
  const [kind, setKind] = useState<DocKind>(creditFor ? "CREDIT_NOTE" : "BILL");
  const [h, setH] = useState(() => ({ supplierId: "", supplierInvoiceNo: "", billDate: riyadhToday(), dueDate: "", branchId: "", description: "", originalBillId: creditFor ?? "", reason: "" }));
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [postedBills, setPostedBills] = useState<BillRow[]>([]);
  const [original, setOriginal] = useState<Original | null>(null);
  const [returnDocs, setReturnDocs] = useState<ReturnDoc[]>([]);
  const [receiptLines, setReceiptLines] = useState<ReceiptLine[]>([]);
  const [own, setOwn] = useState<{ originalBillId: string; gross: number } | null>(null);
  const [busy, setBusy] = useState<"" | "draft" | "submit">("");
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    api<Supplier[]>("/api/accounting/suppliers").then(setSuppliers).catch(() => {});
    api<Account[]>("/api/accounting/coa").then(setAccounts).catch(() => {});
    api<{ branches: Dim[]; costCenters: Dim[] }>("/api/accounting/dimensions").then(setDims).catch(() => {});
    api<Tax[]>("/api/accounting/tax-categories").then((t) => {
      setTaxes(t.filter((x) => x.isActive));
      const def = t.find((x) => x.isDefault && x.isActive)?.id ?? "";
      if (!editId) setLines([blank(def)]);
    }).catch(() => {});
    if (creditFor && !editId) api<Original>(`/api/accounting/bills/${creditFor}`).then((o) => { setH((x) => ({ ...x, supplierId: o.supplierId, originalBillId: o.id })); }).catch((e) => setErr((e as Error).message));
    if (editId) api<{ kind: DocKind; originalBillId: string | null; reason: string | null; totalGross: string; supplierId: string; supplierInvoiceNo: string; billDate: string; dueDate: string; branchId: string | null; description: string | null; status: string;
      lines: { kind: LineKind; accountId: string; description: string | null; quantity: string; unitPrice: string; taxCategoryId: string | null; costCenterId: string | null; invDocumentId: string | null; invDocLineId: string | null }[] }>(`/api/accounting/bills/${editId}`).then((b) => {
      setKind(b.kind ?? "BILL");
      if (b.originalBillId) setOwn({ originalBillId: b.originalBillId, gross: Math.round(Number(b.totalGross) * 100) });
      setH({ supplierId: b.supplierId, supplierInvoiceNo: b.supplierInvoiceNo, billDate: b.billDate.slice(0, 10), dueDate: b.dueDate.slice(0, 10), branchId: b.branchId ?? "", description: b.description ?? "", originalBillId: b.originalBillId ?? "", reason: b.reason ?? "" });
      setLines(b.lines.map((l) => ({ kind: l.kind, accountId: STOCK.has(l.kind) ? "" : l.accountId, description: l.description ?? "", quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unitPrice)), taxCategoryId: l.taxCategoryId ?? "", costCenterId: l.costCenterId ?? "", invDocumentId: l.invDocumentId ?? "", invDocLineId: l.invDocLineId ?? "" })));
    }).catch((e) => setErr((e as Error).message));
  }, [editId, creditFor]);

  const credit = kind === "CREDIT_NOTE";
  // Credit note pickers, per supplier: its posted bills, posted returns to it, its posted receipt lines.
  useEffect(() => {
    if (!credit || !h.supplierId) return;
    api<{ rows: BillRow[] }>(`/api/accounting/bills?status=POSTED&supplierId=${h.supplierId}&pageSize=100`).then((r) => setPostedBills(r.rows.filter((x) => x.kind !== "CREDIT_NOTE"))).catch(() => setPostedBills([]));
    api<{ rows: ReturnDoc[] }>(`/api/accounting/inventory/documents?type=SUPPLIER_RETURN&status=POSTED&supplierId=${h.supplierId}&pageSize=100`).then((r) => setReturnDocs(r.rows.filter((x) => !x.supplierId || x.supplierId === h.supplierId))).catch(() => setReturnDocs([]));
    api<ReceiptLine[]>(`/api/accounting/inventory/pickers?what=receipt-lines&supplierId=${h.supplierId}`).then(setReceiptLines).catch(() => setReceiptLines([]));
  }, [credit, h.supplierId]);
  // What is left to credit on the chosen bill (and that it really is a posted bill).
  useEffect(() => {
    if (!credit || !h.originalBillId) return;
    api<Original>(`/api/accounting/bills/${h.originalBillId}`).then(setOriginal).catch(() => setOriginal(null));
  }, [credit, h.originalBillId]);

  const supplier = suppliers.find((s) => s.id === h.supplierId);
  const eligible = useMemo(() => accounts.filter((a) => a.isActive && a.allowPosting && a.controlKind === "NONE" && (a.type === "EXPENSE" || a.type === "ASSET")), [accounts]);
  const acctName = (a?: { code: string; nameAr: string | null; nameEn: string } | null) => (a ? `${a.code} · ${L(a.nameAr ?? a.nameEn, a.nameEn)}` : "—");
  const byCode = (role: string) => accounts.find((a) => a.roles?.includes(role));
  const rate = (id: string) => taxes.find((t) => t.id === id)?.rate ?? "0";
  const calc = lines.map((l) => lineMinor(l.quantity, l.unitPrice, rate(l.taxCategoryId)));
  const tot = calc.reduce<{ net: number; vat: number; gross: number }>((s, c) => ({ net: s.net + (c?.net ?? 0), vat: s.vat + (c?.vat ?? 0), gross: s.gross + (c?.gross ?? 0) }), { net: 0, vat: 0, gross: 0 });
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineErr = (l: Line, i: number) => {
    if (l.kind === "EXPENSE" && !l.accountId) return L("اختر الحساب", "Choose the account");
    if (l.kind === "STOCK_RETURN" && !l.invDocumentId) return L("اختر مرتجع المورد المرحّل", "Choose the posted supplier return");
    if (l.kind === "STOCK_PRICE_ADJUSTMENT" && !l.invDocLineId) return L("اختر بند الاستلام المرحّل", "Choose the posted receipt line");
    if (!calc[i]) return L("الكمية والسعر أرقام موجبة (حتى 4 خانات عشرية)", "Quantity and price must be positive numbers (up to 4 decimals)");
    if (calc[i]!.net <= 0) return L("المبلغ صفر", "Amount is zero");
    return null;
  };
  const errors = lines.map(lineErr);
  const usedReturns = lines.map((l) => l.invDocumentId).filter(Boolean);
  // The bill's creditable amount counts this draft too while it is being edited.
  const creditLeft = credit && original?.creditable != null ? Math.round(Number(original.creditable) * 100) + (own && own.originalBillId === original.id ? own.gross : 0) : null;
  const headerErr = !h.supplierId ? L("اختر المورد", "Choose the supplier")
    : !h.supplierInvoiceNo.trim() ? (credit ? L("أدخل رقم إشعار المورد", "Enter the supplier's credit note number") : L("أدخل رقم فاتورة المورد", "Enter the supplier's invoice number"))
    : credit && !h.originalBillId ? L("اختر الفاتورة المرحّلة التي يُشعَر عنها", "Choose the posted bill the credit note credits")
    : credit && original && (original.kind !== "BILL" || original.status !== "POSTED") ? L("الإشعار يُقيَّد على فاتورة مرحّلة (لا على إشعار)", "A credit note credits a posted bill (not another credit note)")
    : credit && h.reason.trim().length < 5 ? L("سبب الإشعار (5 أحرف على الأقل)", "Credit note reason (at least 5 characters)")
    : credit && creditLeft !== null && tot.gross > creditLeft ? L("الإشعار يتجاوز المتبقي للإشعار على الفاتورة", "The credit note exceeds what is left to credit on the bill")
    : credit && new Set(usedReturns).size !== usedReturns.length ? L("المرتجع الواحد يُسوّى ببند واحد", "A return is settled by one line only")
    : null;
  const vatWithoutNumber = tot.vat > 0 && supplier && !vatOk(supplier.vatNumber);
  const valid = !headerErr && errors.every((e) => !e) && lines.length > 0;
  const dueDefault = supplier && h.billDate ? new Date(Date.parse(h.billDate) + supplier.paymentTermsDays * 86_400_000).toISOString().slice(0, 10) : "";

  const switchKind = (k: DocKind) => {
    setKind(k); setOriginal(null);
    setH((x) => ({ ...x, originalBillId: "", reason: "" }));
    // Line kinds differ: a bill has goods received; a credit note has returns and price reductions.
    setLines((ls) => ls.map((l) => (l.kind === "EXPENSE" || (k === "BILL" && l.kind === "STOCK_RECEIPT") ? l : { ...l, kind: "EXPENSE", accountId: "", invDocumentId: "", invDocLineId: "" })));
  };
  const pickAccount = (i: number, v: string) => {
    if (PICK[v]) set(i, { kind: PICK[v], accountId: "", invDocumentId: "", invDocLineId: "" });
    else set(i, { kind: "EXPENSE", accountId: v, invDocumentId: "", invDocLineId: "" });
  };
  const pickReturn = (i: number, id: string) => {
    const d = returnDocs.find((x) => x.id === id);
    set(i, { invDocumentId: id, ...(d ? { description: lines[i].description || L(`مرتجع للمورد #${d.docNo}`, `Return to supplier #${d.docNo}`), ...(!lines[i].unitPrice && d.value ? { quantity: "1", unitPrice: Number(d.value).toFixed(2) } : {}) } : {}) });
  };
  const pickReceiptLine = (i: number, id: string) => {
    const r = receiptLines.find((x) => x.id === id);
    set(i, { invDocLineId: id, ...(r ? { description: lines[i].description || L(`تخفيض سعر · استلام #${r.docNo} · ${r.item}`, `Price reduction · receipt #${r.docNo} · ${r.item}`) } : {}) });
  };

  async function save(submit: boolean) {
    setTouched(true); setErr(null);
    if (!valid) return;
    setBusy(submit ? "submit" : "draft");
    try {
      const body = { ...h, kind, originalBillId: credit ? h.originalBillId || null : null, reason: credit ? h.reason : null, dueDate: h.dueDate || null, branchId: h.branchId || null,
        lines: lines.map((l) => ({ ...l, accountId: l.kind === "EXPENSE" ? l.accountId : undefined, taxCategoryId: l.taxCategoryId || null, costCenterId: l.costCenterId || null,
          invDocumentId: l.kind === "STOCK_RETURN" ? l.invDocumentId : null, invDocLineId: l.kind === "STOCK_PRICE_ADJUSTMENT" ? l.invDocLineId : null })) };
      const b = editId ? await api<{ id: string }>(`/api/accounting/bills/${editId}`, { method: "PATCH", json: body }) : await api<{ id: string }>("/api/accounting/bills", { method: "POST", json: body });
      if (submit) await api(`/api/accounting/bills/${b.id}/submit`, { method: "POST", json: {} });
      router.push(`/dashboard/accounting/payables/${b.id}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); setBusy(""); }
  }

  if (!can("ap_bill_create")) return <Notice tone="warn">{L("لا تملك صلاحية إعداد فواتير الموردين.", "You cannot prepare supplier bills.")}</Notice>;
  const grni = byCode("GRNI"), vatAcc = byCode("INPUT_VAT"), ap = byCode("AP_CONTROL");
  const lineAccount = (l: Line) => (STOCK.has(l.kind) ? acctName(grni) : acctName(accounts.find((a) => a.id === l.accountId)));
  const title = credit
    ? (editId ? L("تعديل إشعار دائن من مورد (مسودة)", "Edit supplier credit note (draft)") : L("إشعار دائن جديد من مورد", "New supplier credit note"))
    : (editId ? L("تعديل فاتورة مورد (مسودة)", "Edit supplier bill (draft)") : L("فاتورة مورد جديدة", "New supplier bill"));
  return (
    <Card>
      <CardTitle title={title} sub={credit ? L("يُعتمد من شخص غير مُعدّه · لا يتجاوز ما بقي قابلاً للإشعار من الفاتورة", "Approved by someone other than its preparer · never more than is left to credit on the bill") : L("تُعتمد من شخص غير مُعدّها · المبالغ بالريال السعودي بخانتين عشريتين", "Approved by someone other than its preparer · SAR, two decimals")}
        right={editId || creditFor ? undefined : <Segmented<DocKind> value={kind} onChange={switchKind} options={[{ value: "BILL", label: L("فاتورة", "Bill") }, { value: "CREDIT_NOTE", label: L("إشعار دائن", "Credit note") }]} />} />
      <div className="flex gap-3 flex-wrap items-start">
        <Field label={L("المورد", "Supplier")} error={touched && !h.supplierId ? L("مطلوب", "Required") : null}
          hint={supplier ? undefined : L("الموردون من وحدة المشتريات", "Suppliers come from Purchasing")}>
          <select className={`${INPUT} min-w-[240px]`} value={h.supplierId} disabled={!!creditFor} onChange={(e) => { setH({ ...h, supplierId: e.target.value, originalBillId: "" }); setOriginal(null); setLines((ls) => ls.map((l) => ({ ...l, invDocumentId: "", invDocLineId: "" }))); }}>
            <option value="">{L("اختر…", "Choose…")}</option>{suppliers.filter((s) => s.active || s.id === h.supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {supplier && (vatOk(supplier.vatNumber) ? <Badge tone="ok">✓ {L("رقم ضريبي", "VAT no.")} {supplier.vatNumber}</Badge> : <Badge tone="warn">{L("بلا رقم ضريبي — لا تُسترد الضريبة", "No VAT number — VAT not claimable")}</Badge>)}
        </Field>
        <Field label={credit ? L("رقم إشعار المورد", "Supplier credit note no.") : L("رقم فاتورة المورد", "Supplier invoice no.")} hint={L("فريد لكل مورد", "Unique per supplier")} error={touched && !h.supplierInvoiceNo.trim() ? L("مطلوب", "Required") : null}>
          <input className={INPUT} value={h.supplierInvoiceNo} onChange={(e) => setH({ ...h, supplierInvoiceNo: e.target.value })} />
        </Field>
        <Field label={credit ? L("تاريخ الإشعار", "Credit note date") : L("تاريخ الفاتورة", "Bill date")}><input type="date" className={INPUT} value={h.billDate} onChange={(e) => setH({ ...h, billDate: e.target.value })} /></Field>
        {!credit && (
          <Field label={L("الاستحقاق", "Due date")} hint={supplier ? L(`${supplier.paymentTermsDays} يوماً من شروط المورد`, `${supplier.paymentTermsDays} days (supplier terms)`) : undefined}>
            <input type="date" className={INPUT} value={h.dueDate || dueDefault} onChange={(e) => setH({ ...h, dueDate: e.target.value })} />
          </Field>
        )}
        <Field label={L("الفرع", "Branch")}>
          <select className={INPUT} value={h.branchId} onChange={(e) => setH({ ...h, branchId: e.target.value })}><option value="">—</option>{dims.branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr ?? b.nameEn, b.nameEn)}</option>)}</select>
        </Field>
      </div>
      {credit && (
        <div className="flex gap-3 flex-wrap items-start">
          <Field label={L("الفاتورة التي يُشعَر عنها", "Bill credited")} error={touched && !h.originalBillId ? L("مطلوب", "Required") : null}
            hint={h.supplierId ? L("فواتير المورد المرحّلة", "The supplier's posted bills") : L("اختر المورد أولاً", "Choose the supplier first")}>
            <select className={`${INPUT} min-w-[240px]`} value={h.originalBillId} disabled={!h.supplierId || !!creditFor} onChange={(e) => { setH({ ...h, originalBillId: e.target.value }); if (!e.target.value) setOriginal(null); }}>
              <option value="">{L("اختر…", "Choose…")}</option>
              {original && !postedBills.some((b) => b.id === original.id) && <option value={original.id}>ف-{original.billNo} · {original.supplierInvoiceNo}</option>}
              {postedBills.map((b) => <option key={b.id} value={b.id}>ف-{b.billNo} · {b.supplierInvoiceNo} · {money(Math.round(Number(b.totalGross) * 100))}</option>)}
            </select>
          </Field>
          <Field label={L("المتبقي للإشعار", "Left to credit")} hint={L("الفاتورة ناقص إشعارات سابقة", "Bill less earlier credit notes")}><input className={INPUT} readOnly dir="ltr" value={creditLeft !== null ? (creditLeft / 100).toFixed(2) : ""} /></Field>
          <Field label={L("السبب", "Reason")} hint={L("5 أحرف على الأقل", "At least 5 characters")} error={touched && h.reason.trim().length < 5 ? L("مطلوب", "Required") : null}>
            <input className={`${INPUT} min-w-[260px]`} value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} />
          </Field>
        </div>
      )}
      <Table>
        <thead><tr><Th>#</Th><Th>{L("البند / الحساب", "Item / account")}</Th><Th>{L("الوصف", "Description")}</Th><Th num>{L("الكمية", "Qty")}</Th><Th num>{L("سعر الوحدة", "Unit price")}</Th><Th num>{L("الصافي", "Net")}</Th><Th>{L("فئة الضريبة", "Tax category")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th><Th></Th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>{i + 1}</Td>
              <Td className="min-w-[250px]">
                <select aria-label={L(`حساب البند ${i + 1}`, `Line ${i + 1} account`)} className={INPUT} value={l.kind === "EXPENSE" ? l.accountId : Object.keys(PICK).find((k) => PICK[k] === l.kind)}
                  onChange={(e) => pickAccount(i, e.target.value)}>
                  <option value="">{L("اختر…", "Choose…")}</option>
                  {credit ? <>
                    <option value="__return">{L(`بضاعة مرتجعة للمورد ← ${grni?.code ?? "GRNI"}`, `Goods returned to supplier → ${grni?.code ?? "GRNI"}`)}</option>
                    <option value="__price">{L(`تخفيض سعر بضاعة مستلمة ← ${grni?.code ?? "GRNI"}`, `Price reduction on goods received → ${grni?.code ?? "GRNI"}`)}</option>
                  </> : <option value="__stock">{L(`بضاعة مستلمة ← ${grni?.code ?? "2120"}`, `Goods received → ${grni?.code ?? "2120"}`)}</option>}
                  {eligible.map((a) => <option key={a.id} value={a.id}>{acctName(a)}</option>)}
                </select>
                {l.kind === "STOCK_RETURN" && (
                  <select aria-label={L(`مرتجع البند ${i + 1}`, `Line ${i + 1} supplier return`)} className={`${INPUT} mt-1.5`} value={l.invDocumentId} onChange={(e) => pickReturn(i, e.target.value)}>
                    <option value="">{returnDocs.length ? L("مرتجع المورد المرحّل…", "Posted supplier return…") : L("لا مرتجعات مرحّلة لهذا المورد", "No posted returns to this supplier")}</option>
                    {returnDocs.map((d) => <option key={d.id} value={d.id} disabled={usedReturns.includes(d.id) && l.invDocumentId !== d.id}>#{d.docNo} · {d.docDate.slice(0, 10)} · {d.lines.map((x) => `${x.name} ${Number(x.qty)} ${x.unit}`).join("، ")}{d.value ? ` · ${money(Math.round(Number(d.value) * 100))}` : ""}</option>)}
                  </select>
                )}
                {l.kind === "STOCK_PRICE_ADJUSTMENT" && (
                  <select aria-label={L(`بند استلام البند ${i + 1}`, `Line ${i + 1} receipt line`)} className={`${INPUT} mt-1.5`} value={l.invDocLineId} onChange={(e) => pickReceiptLine(i, e.target.value)}>
                    <option value="">{receiptLines.length ? L("بند استلام مرحّل…", "Posted receipt line…") : L("لا استلامات مرحّلة من هذا المورد", "No posted receipts from this supplier")}</option>
                    {receiptLines.map((r) => <option key={r.id} value={r.id}>#{r.docNo} · {r.date.slice(0, 10)} · {r.item} · {Number(r.qty)} {r.baseUnit} · {money(Math.round(Number(r.value) * 100))}</option>)}
                  </select>
                )}
                {touched && errors[i] && <span role="alert" className="block text-[11px] text-red-700 mt-1">{errors[i]}</span>}
              </Td>
              <Td className="min-w-[180px]"><input aria-label={L(`وصف البند ${i + 1}`, `Line ${i + 1} description`)} className={INPUT} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></Td>
              <Td num className="w-[90px]"><input aria-label={L(`كمية البند ${i + 1}`, `Line ${i + 1} quantity`)} inputMode="decimal" dir="ltr" className={`${INPUT} text-end`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></Td>
              <Td num className="w-[120px]"><input aria-label={L(`سعر البند ${i + 1}`, `Line ${i + 1} unit price`)} inputMode="decimal" dir="ltr" className={`${INPUT} text-end`} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} /></Td>
              <Td num>{calc[i] ? money(calc[i]!.net) : "—"}</Td>
              <Td className="min-w-[140px]">
                <select aria-label={L(`ضريبة البند ${i + 1}`, `Line ${i + 1} tax`)} className={INPUT} value={l.taxCategoryId} onChange={(e) => set(i, { taxCategoryId: e.target.value })}>
                  <option value="">{L("خارج النطاق (0%)", "Out of scope (0%)")}</option>{taxes.map((t) => <option key={t.id} value={t.id}>{L(t.nameAr ?? t.nameEn, t.nameEn)}</option>)}
                </select>
              </Td>
              <Td num>{calc[i] ? money(calc[i]!.vat) : "—"}</Td>
              <Td num className="font-bold">{calc[i] ? money(calc[i]!.gross) : "—"}</Td>
              <Td><button type="button" aria-label={L(`حذف البند ${i + 1}`, `Remove line ${i + 1}`)} disabled={lines.length <= 1} className="text-brown hover:text-red-700 disabled:opacity-40 p-1" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><X size={16} /></button></Td>
            </tr>
          ))}
          <tr className="bg-cream-dark font-extrabold"><Td></Td><Td>{L("المجموع", "Total")}</Td><Td></Td><Td></Td><Td></Td><Td num>{money(tot.net)}</Td><Td></Td><Td num>{money(tot.vat)}</Td><Td num>{money(tot.gross)}</Td><Td></Td></tr>
        </tbody>
      </Table>
      <div><Button kind="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, blank(taxes.find((t) => t.isDefault)?.id ?? "")])}>{L("بند", "Line")}</Button></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          {credit ? <>
            <Notice tone="info">{L("الإشعار الدائن من المورد يُخفّض ما تدين به له: يُرحَّل ثم يُطبَّق على فاتورة مفتوحة للمورد نفسه. لا يُنشئ التزام دفع.", "A supplier credit note reduces what you owe: post it, then apply it to an open bill of the same supplier. It creates no payment obligation.")}</Notice>
            {lines.some((l) => l.kind === "STOCK_RETURN") && <Notice tone="warn">{L("بضاعة مرتجعة: خرجت من المخزون بمرتجع مورد مرحّل؛ الإشعار يسوّيها مقابل «بضاعة مستلمة لم تصل فاتورتها» ولا يُحرّك المخزون مرة أخرى.", "Goods returned: they left stock through a posted supplier return; the credit note settles it against goods received not invoiced and moves no stock again.")}</Notice>}
            {lines.some((l) => l.kind === "STOCK_PRICE_ADJUSTMENT") && <Notice tone="warn">{L("تخفيض سعر: يُتتبَّع عبر المخزون والإنتاج والمبيعات — ما بقي في المخزون تنخفض قيمته، وما بيع يذهب لتكلفة المبيعات.", "Price reduction: traced through stock, production and sales — what is still on hand is revalued, what was sold goes to cost of sales.")}</Notice>}
          </> : <>
            {lines.some((l) => l.kind === "STOCK_RECEIPT") && <Notice tone="warn">{L("بند مخزون: يُرحَّل إلى «بضاعة مستلمة لم تصل فاتورتها» ويُطابَق مع استلام المخزون.", "Stock line: posts to goods received not invoiced and is matched to the stock receipt.")}</Notice>}
            <Notice tone="info">{L("عند الترحيل يُنشأ التزام الدفع في التخطيط النقدي تلقائياً — التزام واحد لا اثنان. الدفع يُطابَق من سطر البنك.", "Posting creates the payment obligation in cash planning automatically — one liability, not two. Payment is matched from the bank line.")}</Notice>
          </>}
          {vatWithoutNumber && <Notice tone="bad">{L("المورد بلا رقم تسجيل ضريبي صحيح: لن تُعتمد الفاتورة وفيها ضريبة. أضف الرقم للمورد أو اجعل البنود خارج النطاق.", "The supplier has no valid VAT registration number: a bill with VAT will not be approved. Add the number or mark the lines out of scope.")}</Notice>}
        </div>
        <div className="bg-cream rounded-xl border border-border p-3 flex flex-col gap-2">
          <p className="text-[13px] font-extrabold text-charcoal">{L("معاينة القيد عند الترحيل", "Journal preview on posting")}</p>
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>
              {credit ? <>
                <tr><Td>{acctName(ap)}{supplier ? ` — ${supplier.name}` : ""}</Td><Td num>{money(tot.gross)}</Td><Td num></Td></tr>
                {lines.map((l, i) => <tr key={i}><Td>{lineAccount(l)}</Td><Td num></Td><Td num>{calc[i] ? money(calc[i]!.net) : "—"}</Td></tr>)}
                {tot.vat > 0 && <tr><Td>{acctName(vatAcc)}</Td><Td num></Td><Td num>{money(tot.vat)}</Td></tr>}
              </> : <>
                {lines.map((l, i) => <tr key={i}><Td>{lineAccount(l)}</Td><Td num>{calc[i] ? money(calc[i]!.net) : "—"}</Td><Td num></Td></tr>)}
                {tot.vat > 0 && <tr><Td>{acctName(vatAcc)}</Td><Td num>{money(tot.vat)}</Td><Td num></Td></tr>}
                <tr><Td>{acctName(ap)}{supplier ? ` — ${supplier.name}` : ""}</Td><Td num></Td><Td num>{money(tot.gross)}</Td></tr>
              </>}
              <tr className="bg-cream-dark font-extrabold"><Td>{L("متوازن ✓", "Balanced ✓")}</Td><Td num>{money(tot.gross)}</Td><Td num>{money(tot.gross)}</Td></tr>
            </tbody>
          </Table>
        </div>
      </div>
      {touched && headerErr && <Notice tone="bad">{headerErr}</Notice>}
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2 justify-start">
        <Button kind="primary" busy={busy === "submit"} disabled={!!busy} onClick={() => save(true)}>{L("حفظ وتقديم للاعتماد", "Save and submit")}</Button>
        <Button busy={busy === "draft"} disabled={!!busy} onClick={() => save(false)}>{L("حفظ كمسودة", "Save as draft")}</Button>
        <Button kind="ghost" onClick={() => router.push("/dashboard/accounting/payables")}>{L("إلغاء", "Cancel")}</Button>
      </div>
    </Card>
  );
}
