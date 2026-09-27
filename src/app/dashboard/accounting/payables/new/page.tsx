"use client";

// Figma: ACC-21. Supplier bill editor: supplier with VAT-number check, lines with tax category,
// live totals computed exactly like the server (half-up per line), journal preview, save as
// draft or save and submit. ?edit=<id> edits a draft.
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, X } from "lucide-react";
import { api, ApiError, Badge, Button, Card, CardTitle, Field, INPUT, Notice, Table, Td, Th, useL } from "../../../finance/_components/ui";
import { riyadhToday, useCan } from "../../_components/kit";
import { lineMinor } from "../../_components/bill-math";

type Supplier = { id: string; name: string; vatNumber: string | null; paymentTermsDays: number; active: boolean };
type Account = { id: string; code: string; nameAr: string | null; nameEn: string; type: string; allowPosting: boolean; isActive: boolean; controlKind: string; roles: string[] };
type Tax = { id: string; code: string; nameAr: string | null; nameEn: string; rate: string; isActive: boolean; isDefault: boolean };
type Dim = { id: string; code: string; nameAr: string | null; nameEn: string };
type Line = { kind: "EXPENSE" | "STOCK_RECEIPT"; accountId: string; description: string; quantity: string; unitPrice: string; taxCategoryId: string; costCenterId: string };

const blank = (tax = ""): Line => ({ kind: "EXPENSE", accountId: "", description: "", quantity: "1", unitPrice: "", taxCategoryId: tax, costCenterId: "" });
const vatOk = (v: string | null) => !!v && /^3\d{13}3$/.test(v);

export default function NewBillPage() {
  const { L, money } = useL();
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get("edit");
  const { can } = useCan();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxes, setTaxes] = useState<Tax[]>([]);
  const [dims, setDims] = useState<{ branches: Dim[]; costCenters: Dim[] }>({ branches: [], costCenters: [] });
  const [h, setH] = useState(() => ({ supplierId: "", supplierInvoiceNo: "", billDate: riyadhToday(), dueDate: "", branchId: "", description: "" }));
  const [lines, setLines] = useState<Line[]>([blank()]);
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
    if (editId) api<{ supplierId: string; supplierInvoiceNo: string; billDate: string; dueDate: string; branchId: string | null; description: string | null; status: string; lines: { kind: Line["kind"]; accountId: string; description: string | null; quantity: string; unitPrice: string; taxCategoryId: string | null; costCenterId: string | null }[] }>(`/api/accounting/bills/${editId}`).then((b) => {
      setH({ supplierId: b.supplierId, supplierInvoiceNo: b.supplierInvoiceNo, billDate: b.billDate.slice(0, 10), dueDate: b.dueDate.slice(0, 10), branchId: b.branchId ?? "", description: b.description ?? "" });
      setLines(b.lines.map((l) => ({ kind: l.kind, accountId: l.kind === "STOCK_RECEIPT" ? "" : l.accountId, description: l.description ?? "", quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unitPrice)), taxCategoryId: l.taxCategoryId ?? "", costCenterId: l.costCenterId ?? "" })));
    }).catch((e) => setErr((e as Error).message));
  }, [editId]);

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
    if (!calc[i]) return L("الكمية والسعر أرقام موجبة (حتى 4 خانات عشرية)", "Quantity and price must be positive numbers (up to 4 decimals)");
    if (calc[i]!.net <= 0) return L("المبلغ صفر", "Amount is zero");
    return null;
  };
  const errors = lines.map(lineErr);
  const headerErr = !h.supplierId ? L("اختر المورد", "Choose the supplier") : !h.supplierInvoiceNo.trim() ? L("أدخل رقم فاتورة المورد", "Enter the supplier's invoice number") : null;
  const vatWithoutNumber = tot.vat > 0 && supplier && !vatOk(supplier.vatNumber);
  const valid = !headerErr && errors.every((e) => !e) && lines.length > 0;
  const dueDefault = supplier && h.billDate ? new Date(Date.parse(h.billDate) + supplier.paymentTermsDays * 86_400_000).toISOString().slice(0, 10) : "";

  async function save(submit: boolean) {
    setTouched(true); setErr(null);
    if (!valid) return;
    setBusy(submit ? "submit" : "draft");
    try {
      const body = { ...h, dueDate: h.dueDate || null, branchId: h.branchId || null, lines: lines.map((l) => ({ ...l, accountId: l.kind === "EXPENSE" ? l.accountId : undefined, taxCategoryId: l.taxCategoryId || null, costCenterId: l.costCenterId || null })) };
      const b = editId ? await api<{ id: string }>(`/api/accounting/bills/${editId}`, { method: "PATCH", json: body }) : await api<{ id: string }>("/api/accounting/bills", { method: "POST", json: body });
      if (submit) await api(`/api/accounting/bills/${b.id}/submit`, { method: "POST", json: {} });
      router.push(`/dashboard/accounting/payables/${b.id}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); setBusy(""); }
  }

  if (!can("ap_bill_create")) return <Notice tone="warn">{L("لا تملك صلاحية إعداد فواتير الموردين.", "You cannot prepare supplier bills.")}</Notice>;
  const grni = byCode("GRNI"), vatAcc = byCode("INPUT_VAT"), ap = byCode("AP_CONTROL");
  return (
    <Card>
      <CardTitle title={editId ? L("تعديل فاتورة مورد (مسودة)", "Edit supplier bill (draft)") : L("فاتورة مورد جديدة", "New supplier bill")} sub={L("تُعتمد من شخص غير مُعدّها · المبالغ بالريال السعودي بخانتين عشريتين", "Approved by someone other than its preparer · SAR, two decimals")} />
      <div className="flex gap-3 flex-wrap items-start">
        <Field label={L("المورد", "Supplier")} error={touched && !h.supplierId ? L("مطلوب", "Required") : null}
          hint={supplier ? undefined : L("الموردون من وحدة المشتريات", "Suppliers come from Purchasing")}>
          <select className={`${INPUT} min-w-[240px]`} value={h.supplierId} onChange={(e) => setH({ ...h, supplierId: e.target.value })}>
            <option value="">{L("اختر…", "Choose…")}</option>{suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {supplier && (vatOk(supplier.vatNumber) ? <Badge tone="ok">✓ {L("رقم ضريبي", "VAT no.")} {supplier.vatNumber}</Badge> : <Badge tone="warn">{L("بلا رقم ضريبي — لا تُسترد الضريبة", "No VAT number — VAT not claimable")}</Badge>)}
        </Field>
        <Field label={L("رقم فاتورة المورد", "Supplier invoice no.")} hint={L("فريد لكل مورد", "Unique per supplier")} error={touched && !h.supplierInvoiceNo.trim() ? L("مطلوب", "Required") : null}>
          <input className={INPUT} value={h.supplierInvoiceNo} onChange={(e) => setH({ ...h, supplierInvoiceNo: e.target.value })} />
        </Field>
        <Field label={L("تاريخ الفاتورة", "Bill date")}><input type="date" className={INPUT} value={h.billDate} onChange={(e) => setH({ ...h, billDate: e.target.value })} /></Field>
        <Field label={L("الاستحقاق", "Due date")} hint={supplier ? L(`${supplier.paymentTermsDays} يوماً من شروط المورد`, `${supplier.paymentTermsDays} days (supplier terms)`) : undefined}>
          <input type="date" className={INPUT} value={h.dueDate || dueDefault} onChange={(e) => setH({ ...h, dueDate: e.target.value })} />
        </Field>
        <Field label={L("الفرع", "Branch")}>
          <select className={INPUT} value={h.branchId} onChange={(e) => setH({ ...h, branchId: e.target.value })}><option value="">—</option>{dims.branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr ?? b.nameEn, b.nameEn)}</option>)}</select>
        </Field>
      </div>
      <Table>
        <thead><tr><Th>#</Th><Th>{L("البند / الحساب", "Item / account")}</Th><Th>{L("الوصف", "Description")}</Th><Th num>{L("الكمية", "Qty")}</Th><Th num>{L("سعر الوحدة", "Unit price")}</Th><Th num>{L("الصافي", "Net")}</Th><Th>{L("فئة الضريبة", "Tax category")}</Th><Th num>{L("الضريبة", "VAT")}</Th><Th num>{L("الإجمالي", "Total")}</Th><Th></Th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>{i + 1}</Td>
              <Td className="min-w-[230px]">
                <select aria-label={L(`حساب البند ${i + 1}`, `Line ${i + 1} account`)} className={INPUT} value={l.kind === "STOCK_RECEIPT" ? "__stock" : l.accountId}
                  onChange={(e) => set(i, e.target.value === "__stock" ? { kind: "STOCK_RECEIPT", accountId: "" } : { kind: "EXPENSE", accountId: e.target.value })}>
                  <option value="">{L("اختر…", "Choose…")}</option>
                  <option value="__stock">{L(`بضاعة مستلمة ← ${grni?.code ?? "2120"}`, `Goods received → ${grni?.code ?? "2120"}`)}</option>
                  {eligible.map((a) => <option key={a.id} value={a.id}>{acctName(a)}</option>)}
                </select>
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
          {lines.some((l) => l.kind === "STOCK_RECEIPT") && <Notice tone="warn">{L("بند مخزون: يُرحَّل إلى «بضاعة مستلمة لم تصل فاتورتها» حتى يُفعَّل تقييم المخزون (المرحلة 4) — لا يُفعَّل في الإنتاج قبل اعتماد سياسة التكلفة.", "Stock line: posts to goods received not invoiced until inventory valuation (stage 4) is active — not in production before the costing policy is approved.")}</Notice>}
          {vatWithoutNumber && <Notice tone="bad">{L("المورد بلا رقم تسجيل ضريبي صحيح: لن تُعتمد الفاتورة وفيها ضريبة. أضف الرقم للمورد أو اجعل البنود خارج النطاق.", "The supplier has no valid VAT registration number: a bill with VAT will not be approved. Add the number or mark the lines out of scope.")}</Notice>}
          <Notice tone="info">{L("عند الترحيل يُنشأ التزام الدفع في التخطيط النقدي تلقائياً — التزام واحد لا اثنان. الدفع يُطابَق من سطر البنك.", "Posting creates the payment obligation in cash planning automatically — one liability, not two. Payment is matched from the bank line.")}</Notice>
        </div>
        <div className="bg-cream rounded-xl border border-border p-3 flex flex-col gap-2">
          <p className="text-[13px] font-extrabold text-charcoal">{L("معاينة القيد عند الترحيل", "Journal preview on posting")}</p>
          <Table>
            <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
            <tbody>
              {lines.map((l, i) => <tr key={i}><Td>{l.kind === "STOCK_RECEIPT" ? acctName(grni) : acctName(accounts.find((a) => a.id === l.accountId))}</Td><Td num>{calc[i] ? money(calc[i]!.net) : "—"}</Td><Td num></Td></tr>)}
              {tot.vat > 0 && <tr><Td>{acctName(vatAcc)}</Td><Td num>{money(tot.vat)}</Td><Td num></Td></tr>}
              <tr><Td>{acctName(ap)}{supplier ? ` — ${supplier.name}` : ""}</Td><Td num></Td><Td num>{money(tot.gross)}</Td></tr>
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
