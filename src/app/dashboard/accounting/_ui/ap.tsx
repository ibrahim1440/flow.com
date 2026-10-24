"use client";

// Accounting A3 — the AP pieces shared by «الذمم الدائنة» (accounting) and «فواتير الموردين» (purchasing):
//   InvoiceList   — Figma ACC-50: the metric strip, status chips, the list (overdue in red);
//   InvoiceEditor — Figma ACC-51 / 52: header, lines (receipt · stock · expense; VAT per line), totals, the entry
//                   it will post («القيد عند الترحيل»), and the actions the viewer may take in its state.
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { OpsLoading, Btn } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { Msg, money, todayRiyadh, useApi, useLang, useWrite } from "./shell";

export type InvoiceRow = { id: string; number: string; supplierName: string; supplierRef: string; invoiceDate: string; dueDate: string; status: string; grossTotal: string; paidTotal: string; outstanding: string; overdueDays: number };
type List = { rows: InvoiceRow[]; summary: Record<string, { count: number; gross: string; outstanding: string }>; can: { draft: boolean; ap: boolean }; viewer: { id: string }; simpleMode: boolean };

export const INV_STATUS: Record<string, [string, string, string]> = {
  DRAFT: ["مسودة", "Draft", "neutral"], SUBMITTED: ["بانتظار الاعتماد", "Awaiting approval", "warning"], POSTED: ["مرحّلة", "Posted", "success"], CANCELLED: ["ملغاة", "Cancelled", "cancelled"],
};

export function InvoiceList({ base }: { base: string }) {
  const { L } = useLang();
  const [status, setStatus] = useState<string>("");
  const list = useApi<List>(`/api/accounting/ap/invoices${status ? `?status=${status}` : ""}`);
  const all = useApi<List>("/api/accounting/ap/invoices");
  const s = all.data?.summary ?? {};
  const today = todayRiyadh();
  const posted = all.data?.rows.filter((r) => r.status === "POSTED") ?? [];
  const due7 = posted.filter((r) => Number(r.outstanding) > 0 && r.dueDate <= new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10)).reduce((a, r) => a + Number(r.outstanding), 0);
  const st = (v: string) => { const e = INV_STATUS[v]; return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : v}</span></span>; };
  if (list.error) return <p role="alert" className="hr-err">{list.error}</p>;
  return (
    <>
      <div className="acct-metrics" data-testid="ap-metrics">
        <div className="acct-metric"><span className="k">{L("بانتظار الاعتماد", "Awaiting approval")}</span><span className="v">{money(s.SUBMITTED?.gross ?? "0")}</span><span className="s">{L(`${s.SUBMITTED?.count ?? 0} فاتورة`, `${s.SUBMITTED?.count ?? 0} invoices`)}</span></div>
        <div className="acct-metric"><span className="k">{L("مرحّلة مفتوحة", "Posted, open")}</span><span className="v" data-testid="ap-open">{money(s.POSTED?.outstanding ?? "0")}</span><span className="s">{L(`${s.POSTED?.count ?? 0} فواتير`, `${s.POSTED?.count ?? 0} invoices`)}</span></div>
        <div className="acct-metric"><span className="k">{L("مستحقة خلال 7 أيام", "Due within 7 days")}</span><span className="v">{money(due7)}</span><span className="s"><Link href="/dashboard/accounting/ap?view=aging">{L("أعمار الدائنين", "AP aging")}</Link></span></div>
        <div className="acct-metric"><span className="k">{L("مسودات", "Drafts")}</span><span className="v">{s.DRAFT?.count ?? 0}</span><span className="s">{L("لم تُقدَّم بعد", "Not submitted yet")}</span></div>
      </div>
      <div className="acct-row">
        <div className="acct-chips" role="group" aria-label={L("الحالة", "Status")}>
          {[["", L("الكل", "All")], ["DRAFT", L("مسودة", "Draft")], ["SUBMITTED", L("بانتظار الاعتماد", "Awaiting approval")], ["POSTED", L("مرحّلة", "Posted")], ["CANCELLED", L("ملغاة", "Cancelled")]].map(([k, label]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{label} <span className="hr-num acct-hint">{k ? s[k]?.count ?? 0 : all.data?.rows.length ?? 0}</span></button>
          ))}
        </div>
      </div>
      {!list.data ? <OpsLoading /> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="ap-invoices">
            <thead><tr><th>{L("الفاتورة", "Invoice")}</th><th>{L("المورد", "Supplier")}</th><th className="acct-hide-m">{L("فاتورة المورد", "Supplier ref")}</th><th className="acct-hide-m">{L("التاريخ", "Date")}</th><th className="acct-hide-m">{L("الاستحقاق", "Due")}</th><th className="num">{L("الإجمالي", "Gross")}</th><th className="num">{L("المتبقي", "Open")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
            <tbody>
              {list.data.rows.map((r) => (
                <tr key={r.id} className={r.status === "SUBMITTED" ? "is-header" : undefined}>
                  <td><Link className="acct-code" href={`${base}/${r.id}`}>{r.number}</Link></td>
                  <td>{r.supplierName}</td><td className="acct-hide-m acct-code">{r.supplierRef}</td>
                  <td className="acct-hide-m hr-num">{r.invoiceDate}</td><td className="acct-hide-m hr-num">{r.dueDate}</td>
                  <td className="num hr-num">{money(r.grossTotal)}</td>
                  <td className="num hr-num">{r.status === "POSTED" ? money(r.outstanding) : "—"}</td>
                  <td>{r.overdueDays > 0 ? <span className="hr-dot tone-danger"><span>{L(`متأخرة ${r.overdueDays} يومًا`, `${r.overdueDays} days overdue`)}</span></span> : st(r.status)}</td>
                </tr>
              ))}
              {!list.data.rows.length ? <tr><td colSpan={8} className="acct-hint">{L("لا فواتير.", "No invoices.")}</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="acct-hint">{L("الفاتورة تُدخَل مسودةً وتُقدَّم للاعتماد؛ يعتمدها ويرحّلها محاسب آخر غير من أدخلها. السداد يُسجَّل من «الذمم الدائنة › المدفوعات».", "An invoice is entered as a draft and submitted; another accountant approves and posts it. Payments are recorded under «Payables › Payments».")}</p>
    </>
  );
}

type Supplier = { id: string; name: string; vatNumber: string | null; paymentTermsDays: number | null };
type Category = { id: string; code: string; nameAr: string; isActive: boolean; account: { code: string; nameAr: string | null; nameEn: string } };
type Receipt = { purchaseRecordId: string; supplierId: string; date: string; quantity: string; value: string; type: string; glState: string };
type StockItems = { greens: { id: string; label: string }[]; materials: { id: string; label: string }[] };
type Line = { kind: "GRN" | "STOCK" | "EXPENSE"; purchaseRecordId: string; stockKind: "GREEN_BEAN" | "MATERIAL"; stockItemId: string; expenseCategoryId: string; description: string; quantity: string; net: string; vatRate: string };
export type Invoice = {
  id: string; number: string; supplierId: string; supplier: { name: string; vatNumber: string | null }; supplierRef: string; invoiceDate: string; dueDate: string; status: string; notes: string | null;
  netTotal: string; vatTotal: string; grossTotal: string; paidTotal: string; outstanding: string; createdBy: string; lastEditedBy: string | null; submittedBy: string | null; postedBy: string | null; journalEntryId: string | null; cancelReason: string | null;
  lines: { kind: Line["kind"]; purchaseRecordId: string | null; stockKind: string | null; stockItemId: string | null; expenseCategoryId: string | null; description: string; quantity: string | null; net: string; vatRate: string; vat: string; gross: string; matchedValue: string | null; variance: string | null; capitalized: string | null; expenseCategory: { code: string; nameAr: string; account: { code: string; nameAr: string | null; nameEn: string } } | null }[];
  allocations: { id: string; amount: string; payment: { number: string; paymentDate: string; status: string } }[];
};

const blank = (): Line => ({ kind: "EXPENSE", purchaseRecordId: "", stockKind: "MATERIAL", stockItemId: "", expenseCategoryId: "", description: "", quantity: "", net: "", vatRate: "15" });
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function InvoiceEditor({ id, base, can }: { id: string | null; base: string; can: { draft: boolean; ap: boolean; viewerId: string; simpleMode: boolean; sodSelfAllowed?: boolean } }) {
  const { L } = useLang();
  const router = useRouter();
  const inv = useApi<Invoice>(id ? `/api/accounting/ap/invoices/${id}` : null);
  const sups = useApi<Supplier[]>("/api/accounting/ap/suppliers");
  const cats = useApi<Category[]>("/api/accounting/ap/categories");
  const items = useApi<StockItems>("/api/accounting/ap/stock-items");
  const w = useWrite();
  const [form, setForm] = useState<{ base: Invoice | null; supplierId: string; supplierRef: string; invoiceDate: string; dueDate: string; notes: string; lines: Line[] } | null>(null);
  const [dialog, setDialog] = useState<null | "post" | "cancel" | "return">(null);
  const [reason, setReason] = useState("");
  const data = inv.data;
  const fromInvoice = (x: Invoice) => ({ base: x, supplierId: x.supplierId, supplierRef: x.supplierRef, invoiceDate: x.invoiceDate, dueDate: x.dueDate, notes: x.notes ?? "", lines: x.lines.map((l) => ({ kind: l.kind, purchaseRecordId: l.purchaseRecordId ?? "", stockKind: (l.stockKind as Line["stockKind"]) ?? "MATERIAL", stockItemId: l.stockItemId ?? "", expenseCategoryId: l.expenseCategoryId ?? "", description: l.description, quantity: l.quantity ?? "", net: l.net, vatRate: l.vatRate })) });
  const f = form && form.base === (data ?? null) ? form : data ? fromInvoice(data) : { base: null, supplierId: "", supplierRef: "", invoiceDate: todayRiyadh(), dueDate: "", notes: "", lines: [blank()] };
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  const setLine = (i: number, patch: Partial<Line>) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const receipts = useApi<Receipt[]>(f.supplierId ? `/api/accounting/ap/receipts?supplierId=${f.supplierId}` : null);
  const editable = (!data || data.status === "DRAFT") && can.draft;
  const supplier = sups.data?.find((s) => s.id === f.supplierId);
  const calc = f.lines.map((l) => { const net = Number(l.net) || 0; const vat = r2(net * (Number(l.vatRate) || 0) / 100); return { net, vat, gross: r2(net + vat) }; });
  const tot = calc.reduce((a, c) => ({ net: r2(a.net + c.net), vat: r2(a.vat + c.vat), gross: r2(a.gross + c.gross) }), { net: 0, vat: 0, gross: 0 });
  const preview = (() => {
    const dr: [string, number][] = [];
    f.lines.forEach((l, i) => {
      const net = calc[i]?.net ?? 0;
      if (l.kind === "GRN") {
        const rc = receipts.data?.find((r) => r.purchaseRecordId === l.purchaseRecordId);
        const matched = rc ? Number(rc.value) : net;
        dr.push([L("بضاعة مستلمة لم تصل فاتورتها", "GRNI"), matched]);
        if (r2(net - matched)) dr.push([L("المخزون / فرق السعر", "Inventory / price variance"), r2(net - matched)]);
      } else if (l.kind === "STOCK") dr.push([l.stockKind === "GREEN_BEAN" ? L("مخزون البن الأخضر", "Green coffee") : L("مخزون مواد التغليف", "Packaging"), net]);
      else { const c = cats.data?.find((x) => x.id === l.expenseCategoryId); dr.push([c ? `${c.account.code} ${L(c.account.nameAr ?? c.account.nameEn, c.account.nameEn)}` : L("حساب المصروف", "Expense account"), net]); }
    });
    if (tot.vat) dr.push([L("ضريبة المدخلات", "VAT input"), tot.vat]);
    return dr.filter(([, v]) => v);
  })();
  const payload = () => ({ supplierId: f.supplierId, supplierRef: f.supplierRef, invoiceDate: f.invoiceDate, dueDate: f.dueDate || null, notes: f.notes || null, lines: f.lines.map((l) => ({ kind: l.kind, purchaseRecordId: l.kind === "GRN" ? l.purchaseRecordId : null, stockKind: l.kind === "STOCK" ? l.stockKind : null, stockItemId: l.kind === "STOCK" ? l.stockItemId : null, expenseCategoryId: l.kind === "EXPENSE" ? l.expenseCategoryId : null, description: l.description || null, quantity: l.quantity || null, net: l.net || "0", vatRate: l.vatRate })) });

  async function save(submit: boolean) {
    const saved = await w.run<Invoice>("save", id ? `/api/accounting/ap/invoices/${id}` : "/api/accounting/ap/invoices", id ? "PUT" : "POST", payload(), submit ? undefined : L("حُفظت المسودة.", "Draft saved."));
    if (!saved) return;
    if (submit) await w.run("submit", `/api/accounting/ap/invoices/${saved.id}/submit`, "POST", {}, L("قُدّمت الفاتورة للاعتماد.", "Submitted for approval."));
    setForm(null);
    if (!id) router.replace(`${base}/${saved.id}`); else inv.reload();
  }
  async function act(kind: "post" | "cancel" | "return") {
    const ok = kind === "post" ? L("اعتُمدت الفاتورة ورُحّلت.", "Approved and posted.") : kind === "cancel" ? L("أُلغيت الفاتورة وعُكس قيدها.", "Cancelled; its entry is reversed.") : L("أُعيدت للمسودة.", "Returned to draft.");
    if (await w.run(kind, `/api/accounting/ap/invoices/${id}/${kind}`, "POST", kind === "post" ? {} : { reason }, ok)) { setDialog(null); setReason(""); setForm(null); inv.reload(); }
  }
  if (id && (inv.error || !data)) return inv.error ? <p role="alert" className="hr-err">{inv.error}</p> : <OpsLoading />;
  const own = !!data && !(can.sodSelfAllowed ?? can.simpleMode) && [data.createdBy, data.lastEditedBy, data.submittedBy].includes(can.viewerId);
  const st = data ? INV_STATUS[data.status] : null;

  return (
    <div className="acct-split">
      <div className="hr-stack">
        <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
        {data ? <p className="acct-meta"><span className={`hr-dot tone-${st?.[2] ?? "neutral"}`}><span>{st ? L(st[0], st[1]) : data.status}</span></span> <span className="acct-code">{data.number}</span>{data.journalEntryId ? <> · <Link href={`/dashboard/accounting/journals/${data.journalEntryId}`}>{L("القيد", "The entry")}</Link></> : null}{data.cancelReason ? <> · {L("سبب الإلغاء", "Reason")}: {data.cancelReason}</> : null}</p> : null}
        <div className="acct-row">
          <label className="hr-field acct-grow"><span className="hr-label">{L("المورد", "Supplier")}</span>
            <Select value={f.supplierId} disabled={!editable} onChange={(e) => set({ supplierId: e.target.value })} placeholder={L("اختر المورد", "Choose the supplier")} data-testid="inv-supplier">
              <option value="">{L("اختر المورد", "Choose the supplier")}</option>
              {(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <span className="acct-hint">{supplier?.vatNumber ? `${L("الرقم الضريبي", "VAT no.")} ${supplier.vatNumber}` : L("لا رقم ضريبي مسجّل", "No VAT number on file")}</span>
          </label>
          <label className="hr-field"><span className="hr-label">{L("رقم فاتورة المورد", "Supplier invoice no.")}</span><input className="hr-input" disabled={!editable} value={f.supplierRef} onChange={(e) => set({ supplierRef: e.target.value })} data-testid="inv-ref" /><span className="acct-hint">{L("لا يتكرر للمورد نفسه", "Unique per supplier")}</span></label>
        </div>
        <div className="acct-row">
          <label className="hr-field"><span className="hr-label">{L("تاريخ الفاتورة", "Invoice date")}</span><input type="date" className="hr-input" disabled={!editable} value={f.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} data-testid="inv-date" /></label>
          <label className="hr-field"><span className="hr-label">{L("الاستحقاق", "Due date")}</span><input type="date" className="hr-input" disabled={!editable} value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /><span className="acct-hint">{L(`فارغ = شروط المورد (${supplier?.paymentTermsDays ?? 30} يومًا)`, `Empty = supplier terms (${supplier?.paymentTermsDays ?? 30} days)`)}</span></label>
        </div>
        <h2 style={{ margin: 0, fontSize: 16 }}>{L("السطور", "Lines")} <span className="acct-hint">{L("الضريبة على كل سطر وتُقرَّب لأقرب هللة", "VAT per line, rounded to the halala")}</span></h2>
        <div className="hr-tablewrap">
          <table className="hr-table acct-lines" data-testid="inv-lines">
            <thead><tr><th>{L("النوع", "Kind")}</th><th>{L("البند", "Item")}</th><th className="acct-hide-m">{L("البيان", "Description")}</th><th className="num">{L("الصافي", "Net")}</th><th className="num acct-hide-m">{L("الضريبة %", "VAT %")}</th><th className="num">{L("الإجمالي", "Gross")}</th>{editable ? <th /> : null}</tr></thead>
            <tbody>
              {f.lines.map((l, i) => (
                <tr key={i}>
                  <td>{editable ? <Select value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as Line["kind"] })} aria-label={L("النوع", "Kind")}>
                    <option value="EXPENSE">{L("مصروف", "Expense")}</option><option value="GRN">{L("استلام بضاعة", "Goods receipt")}</option><option value="STOCK">{L("مخزون دون استلام", "Stock (no receipt)")}</option>
                  </Select> : (l.kind === "GRN" ? L("استلام", "Receipt") : l.kind === "STOCK" ? L("مخزون", "Stock") : L("مصروف", "Expense"))}</td>
                  <td>
                    {l.kind === "GRN" ? (editable ? <Select value={l.purchaseRecordId} onChange={(e) => { const rc = receipts.data?.find((r) => r.purchaseRecordId === e.target.value); setLine(i, { purchaseRecordId: e.target.value, net: l.net || rc?.value || "" }); }} placeholder={L("اختر الاستلام", "Choose the receipt")}>
                      <option value="">{L("اختر الاستلام", "Choose the receipt")}</option>
                      {(receipts.data ?? []).map((r) => <option key={r.purchaseRecordId} value={r.purchaseRecordId}>{`${r.date} · ${r.quantity} · ${money(r.value)}`}</option>)}
                    </Select> : <span className="acct-code">{data?.lines[i]?.matchedValue ? `${L("قيمة الاستلام", "Receipt")} ${money(data.lines[i].matchedValue)} · ${L("فرق", "variance")} ${money(data.lines[i].variance)}` : l.purchaseRecordId.slice(-8)}</span>)
                      : l.kind === "STOCK" ? (editable ? <span className="acct-actions"><Select value={l.stockKind} onChange={(e) => setLine(i, { stockKind: e.target.value as Line["stockKind"], stockItemId: "" })}><option value="MATERIAL">{L("مادة", "Material")}</option><option value="GREEN_BEAN">{L("بن أخضر", "Green coffee")}</option></Select>
                        <Select value={l.stockItemId} onChange={(e) => setLine(i, { stockItemId: e.target.value })} placeholder={L("الصنف", "Item")}><option value="">{L("الصنف", "Item")}</option>{(l.stockKind === "GREEN_BEAN" ? items.data?.greens : items.data?.materials)?.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
                        <input className="hr-input acct-amount" style={{ width: 80 }} placeholder={L("الكمية", "Qty")} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></span> : <span>{l.quantity ? `${l.quantity} · ` : ""}{L("مخزون", "stock")}</span>)
                      : (editable ? <Select value={l.expenseCategoryId} onChange={(e) => setLine(i, { expenseCategoryId: e.target.value })} placeholder={L("فئة المصروف", "Expense category")}><option value="">{L("فئة المصروف", "Expense category")}</option>{(cats.data ?? []).filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{`${c.account.code} · ${c.nameAr}`}</option>)}</Select>
                        : <span>{data?.lines[i]?.expenseCategory ? `${data.lines[i].expenseCategory!.account.code} · ${data.lines[i].expenseCategory!.nameAr}` : "—"}</span>)}
                  </td>
                  <td className="acct-hide-m">{editable ? <input className="hr-input" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /> : l.description}</td>
                  <td className="num">{editable ? <input className="hr-input acct-amount" inputMode="decimal" style={{ width: 110 }} value={l.net} onChange={(e) => setLine(i, { net: e.target.value })} aria-label={L("الصافي", "Net")} data-testid={`inv-net-${i}`} /> : <span className="hr-num">{money(l.net)}</span>}</td>
                  <td className="num acct-hide-m">{editable ? <input className="hr-input acct-amount" inputMode="decimal" style={{ width: 60 }} value={l.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })} /> : <span className="hr-num">{l.vatRate}</span>}</td>
                  <td className="num hr-num">{money(calc[i]?.gross ?? 0)}</td>
                  {editable ? <td><Btn variant="ghost" size="sm" aria-label={L("حذف السطر", "Remove line")} onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })}>✕</Btn></td> : null}
                </tr>
              ))}
              <tr className="is-total"><td colSpan={3} className="acct-hide-m">{L("المجموع (ر.س)", "Total (SAR)")}</td><td className="num hr-num" data-testid="inv-net-total">{money(tot.net)}</td><td className="num hr-num acct-hide-m">{money(tot.vat)}</td><td className="num hr-num" data-testid="inv-gross-total">{money(tot.gross)}</td>{editable ? <td /> : null}</tr>
            </tbody>
          </table>
        </div>
        {editable ? <div><Btn size="sm" onClick={() => set({ lines: [...f.lines, blank()] })} data-testid="inv-add-line">+ {L("سطر", "Line")}</Btn></div> : null}
        <div className="acct-actions">
          {editable ? <>
            <Btn variant="primary" busy={w.busy === "save" || w.busy === "submit"} onClick={() => save(true)} data-testid="inv-submit">{L("حفظ وتقديم للاعتماد", "Save and submit")}</Btn>
            <Btn busy={w.busy === "save"} onClick={() => save(false)} data-testid="inv-save">{L("حفظ كمسودة", "Save as draft")}</Btn>
            {id ? <Btn variant="ghost" onClick={async () => { if (await w.run("del", `/api/accounting/ap/invoices/${id}`, "DELETE")) router.replace(base); }}>{L("حذف المسودة", "Delete draft")}</Btn> : <Link className="hr-btn is-ghost" href={base}>{L("إلغاء", "Cancel")}</Link>}
          </> : null}
          {data && can.ap && (data.status === "SUBMITTED" || (can.simpleMode && data.status === "DRAFT")) ? <>
            <Btn variant="primary" disabled={own} onClick={() => setDialog("post")} data-testid="inv-post">{L("اعتماد وترحيل", "Approve and post")}</Btn>
            {data.status === "SUBMITTED" ? <Btn onClick={() => setDialog("return")}>{L("إعادة للمسودة", "Return to draft")}</Btn> : null}
          </> : null}
          {data && can.ap && data.status === "POSTED" && Number(data.paidTotal) === 0 ? <Btn variant="danger" onClick={() => setDialog("cancel")} data-testid="inv-cancel">{L("إلغاء الفاتورة", "Cancel the invoice")}</Btn> : null}
        </div>
        {own && data?.status === "SUBMITTED" ? <p className="acct-hint">{L("أدخلت هذه الفاتورة أو قدّمتها؛ يعتمدها شخص آخر (فصل المهام).", "You entered or submitted this invoice; another person approves it (segregation of duties).")}</p> : null}
        {data?.allocations.length ? <p className="acct-hint">{L("السداد", "Payments")}: {data.allocations.map((a) => `${a.payment.number} (${money(a.amount)}${a.payment.status === "VOIDED" ? L(" — ملغى", " — voided") : ""})`).join("، ")}</p> : null}
      </div>
      <aside className="acct-card" aria-label={L("القيد عند الترحيل", "The entry on posting")} data-testid="inv-preview">
        <h3>{L("القيد عند الترحيل", "The entry on posting")}</h3>
        <table className="hr-table is-dense">
          <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th></tr></thead>
          <tbody>
            {preview.map(([k, v], i) => <tr key={i}><td>{k}</td><td className="num hr-num">{v > 0 ? money(v) : ""}</td><td className="num hr-num">{v < 0 ? money(-v) : ""}</td></tr>)}
            <tr><td>{L("ذمم دائنة", "Accounts payable")} · {supplier?.name ?? "—"}</td><td /><td className="num hr-num">{money(tot.gross)}</td></tr>
            <tr className="is-total"><td>{L("المجموع", "Total")}</td><td className="num hr-num">{money(tot.gross)}</td><td className="num hr-num">{money(tot.gross)}</td></tr>
          </tbody>
        </table>
        <p className="acct-hint">{L("لا يُرحَّل شيء قبل اعتماد شخص غيرك ثم الترحيل. قبل تفعيل المحاسبة تُسجَّل الفاتورة دون قيد.", "Nothing posts before another person approves. Before accounting is activated the invoice is recorded without an entry.")}</p>
      </aside>
      <Dialog open={!!dialog} title={dialog === "post" ? L("اعتماد الفاتورة وترحيلها", "Approve and post") : dialog === "cancel" ? L("إلغاء الفاتورة المرحّلة", "Cancel the posted invoice") : L("إعادة الفاتورة للمسودة", "Return to draft")} onClose={() => setDialog(null)}
        actions={<><Btn onClick={() => setDialog(null)}>{L("رجوع", "Back")}</Btn><Btn variant={dialog === "cancel" ? "danger" : "primary"} busy={!!w.busy} disabled={dialog !== "post" && reason.trim().length < 3} onClick={() => dialog && act(dialog)} data-testid="inv-confirm">{L("تأكيد", "Confirm")}</Btn></>}>
        {dialog === "post" ? <p>{L(`يُرحَّل قيد بإجمالي ${money(data?.grossTotal)} ر.س على حساب المورد ${data?.supplier.name ?? ""}. لا يُعدَّل بعد ذلك؛ التصحيح بالإلغاء.`, `An entry of SAR ${money(data?.grossTotal)} posts to ${data?.supplier.name ?? ""}. It is not edited afterwards; a correction is a cancellation.`)}</p>
          : <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="inv-reason" /></label>}
      </Dialog>
    </div>
  );
}
