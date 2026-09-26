"use client";

import { useState } from "react";
import { Wallet, TrendingDown, ShieldCheck, AlertOctagon, Plus, FileDown, Replace, XCircle } from "lucide-react";
import { useUser } from "../../user-context";
import { Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, Kpi, LoadingState, Notice, Table, Td, Th, api, useApi, useFinance, useHasSub, useL, withBranch, type Tone } from "../_components/ui";

type Week = { index: number; start: string; end: string; opening: number; receipts: number; payments: number; closing: number };
type Forecast = { opening: number; base: { weeks: Week[]; lowestClosing: number; lowestWeek: number; firstShortfallWeek: number | null }; conservative: { weeks: Week[]; lowestClosing: number; firstShortfallWeek: number | null }; assumptions: { conservativeDelayWeeks: number; conservativeCollectPct: number } };
type Ob = { id: string; type: string; description: string; counterparty: string | null; amount: number; paid: number; remaining: number; reserved: number; dueDate: string; status: string; allocationCategoryId: string | null; sourceType: string };
type Item = { id: string; kind: string; description: string; amount: string; expectedDate: string; status: string };
type Setup = { finCategories: { id: string; nameEn: string; nameAr: string | null; kind: string }[]; branches: { id: string; nameEn: string; nameAr: string | null }[]; scope: { all: boolean } };
type Cat = { id: string; nameEn: string; nameAr: string | null; branchKey: string };

const TYPES: Record<string, [string, string]> = { SUPPLIER_BILL: ["فاتورة مورد", "Supplier bill"], PURCHASE_ORDER: ["أمر شراء", "Purchase order"], PAYROLL: ["رواتب", "Payroll"], RENT: ["إيجار", "Rent"], TAX: ["ضريبة", "Tax"], LOAN_REPAYMENT: ["سداد قرض", "Loan repayment"], UTILITIES: ["مرافق", "Utilities"], OTHER: ["أخرى", "Other"] };
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export default function ObligationsPage() {
  const { L, money } = useL();
  const user = useUser();
  const { refresh, branch } = useFinance();
  const canPrepare = useHasSub(user?.permissions, "budget_prepare");
  const fc = useApi<Forecast>("/api/finance/forecast");
  const ov = useApi<{ unfunded: { id: string; unfunded: number }[]; unfundedTotal: number }>("/api/finance/overview");
  const obs = useApi<{ rows: Ob[]; total: number }>("/api/finance/obligations?take=500");
  const items = useApi<Item[]>("/api/finance/forecast-items");
  const setup = useApi<Setup>("/api/finance/setup");
  const cats = useApi<Cat[]>("/api/finance/categories");
  const [showAll, setShowAll] = useState(false);
  const [dlg, setDlg] = useState<null | "ob" | "item">(null);
  const [supersede, setSupersede] = useState<Ob | null>(null);
  const reloadAll = () => { fc.reload(); ov.reload(); obs.reload(); items.reload(); refresh(); };

  if (fc.loading && !fc.data) return <LoadingState />;
  if (fc.error) return <ErrorState error={fc.error} onRetry={fc.reload} />;
  const f = fc.data!;
  const lowW = f.base.weeks[f.base.lowestWeek - 1];
  const unfundedBy = new Map((ov.data?.unfunded ?? []).map((u) => [u.id, u.unfunded]));
  const rows = obs.data?.rows ?? [];
  const shown = showAll ? rows : rows.slice(0, 8);
  const shortfall = (n: number | null, lowest: number) => (n ? L(`الأسبوع ${n}`, `Week ${n}`) : L("لا يوجد", "None")) + (n ? "" : L(` (أدنى ${money(lowest)})`, ` (lowest ${money(lowest)})`));

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Kpi icon={Wallet} tone="brand" label={L("النقد الافتتاحي (مؤكد، غير مقيد)", "Opening cash (confirmed, unrestricted)")} value={money(f.opening)} sub={L(`بداية الأسبوع ${ddmm(f.base.weeks[0].start)}`, `Week starting ${ddmm(f.base.weeks[0].start)}`)} />
        <Kpi icon={TrendingDown} tone="warn" label={L("أدنى رصيد متوقع", "Lowest projected balance")} value={money(f.base.lowestClosing)} sub={lowW ? L(`الأسبوع ${lowW.index} · ${ddmm(lowW.start)} – ${ddmm(lowW.end)}`, `Week ${lowW.index} · ${ddmm(lowW.start)} – ${ddmm(lowW.end)}`) : undefined} valueClass={f.base.lowestClosing < 0 ? "text-red-600" : ""} />
        <Kpi icon={ShieldCheck} tone={f.base.firstShortfallWeek ? "bad" : "ok"} label={L("أول عجز متوقع", "First projected shortfall")} value={f.base.firstShortfallWeek ? L(`الأسبوع ${f.base.firstShortfallWeek}`, `Week ${f.base.firstShortfallWeek}`) : L("لا يوجد", "None")} valueClass={f.base.firstShortfallWeek ? "text-red-600" : "text-green-600"} sub={L(`المتحفظ: ${shortfall(f.conservative.firstShortfallWeek, f.conservative.lowestClosing)}`, `Conservative: ${shortfall(f.conservative.firstShortfallWeek, f.conservative.lowestClosing)}`)} />
        <Kpi icon={AlertOctagon} tone="bad" label={L("التزامات غير ممولة", "Unfunded obligations")} value={money(ov.data?.unfundedTotal ?? 0)} valueClass="text-red-600" sub={L(`${ov.data?.unfunded.length ?? 0} التزاماً`, `${ov.data?.unfunded.length ?? 0} obligations`)} />
      </div>

      <Card pad="p-4">
        <CardTitle title={L("التوقع النقدي المتجدد — 13 أسبوعاً", "Rolling cash forecast — 13 weeks")}
          sub={L(`الختامي لكل أسبوع هو افتتاحي الأسبوع التالي · المتحفظ: تأخر التحصيل ${f.assumptions.conservativeDelayWeeks} أسبوع وتحصيل ${f.assumptions.conservativeCollectPct}%`, `Each week's closing is the next week's opening · conservative: collections ${f.assumptions.conservativeDelayWeeks} weeks late at ${f.assumptions.conservativeCollectPct}%`)}
          right={<>
            <a href={withBranch("/api/finance/export?kind=forecast&format=xlsx", branch)} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-bold bg-white border border-border"><FileDown size={16} />{L("تصدير", "Export")}</a>
            {canPrepare && <Button icon={Plus} onClick={() => setDlg("item")}>{L("متحصل متوقع", "Expected item")}</Button>}
            {canPrepare && <Button kind="primary" icon={Plus} onClick={() => setDlg("ob")}>{L("التزام جديد", "New obligation")}</Button>}
          </>} />
        <Table>
          <thead><tr><Th>{L("الأسبوع", "Week")}</Th><Th>{L("يبدأ", "Starts")}</Th><Th num>{L("الافتتاحي", "Opening")}</Th><Th num>{L("مقبوضات متوقعة", "Expected receipts")}</Th><Th num>{L("مدفوعات متوقعة", "Expected payments")}</Th><Th num>{L("الختامي", "Closing")}</Th><Th num>{L("الختامي (متحفظ)", "Closing (conservative)")}</Th></tr></thead>
          <tbody>{f.base.weeks.map((w, i) => {
            const c = f.conservative.weeks[i];
            return (
              <tr key={w.index} className={w.index === f.base.lowestWeek ? "bg-amber-100" : ""}>
                <Td className="font-bold">{w.index}</Td><Td className="text-brown">{ddmm(w.start)}</Td><Td num className="text-brown">{money(w.opening)}</Td>
                <Td num className="text-green-600">{money(w.receipts)}</Td><Td num>{money(w.payments)}</Td>
                <Td num className={`font-bold ${w.closing < 0 ? "text-red-600" : ""}`}>{money(w.closing)}</Td><Td num className={c.closing < 0 ? "text-red-600 font-bold" : "text-amber-700"}>{money(c.closing)}</Td>
              </tr>
            );
          })}</tbody>
        </Table>
        <p className="text-xs text-brown">{L("المدفوعات = الالتزامات المفتوحة (المتبقي فقط، دون المستبدلة) + طلبات دفع غير مرتبطة بالتزام + مدفوعات متوقعة أخرى. التخصيصات الداخلية لا تُخصم.", "Payments = open obligations (remaining only, never superseded ones) + payment requests not tied to an obligation + other expected payments. Internal allocations are not deducted.")}</p>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px] gap-4 items-start">
        <Card pad="p-4">
          <CardTitle title={L("الالتزامات المفتوحة", "Open obligations")} sub={L("مرتبة حسب الاستحقاق · التمويل من رصيد فئة التخصيص المرتبطة", "By due date · funded from the linked allocation category's balance")} />
          {obs.loading && !obs.data ? <LoadingState /> : obs.error ? <ErrorState error={obs.error} onRetry={obs.reload} /> : rows.length === 0 ? <EmptyState title={L("لا توجد التزامات مفتوحة", "No open obligations")} /> : (
            <>
              <Table>
                <thead><tr><Th>{L("الاستحقاق", "Due")}</Th><Th>{L("الالتزام", "Obligation")}</Th><Th>{L("النوع", "Type")}</Th><Th num>{L("المتبقي", "Remaining")}</Th><Th>{L("التمويل", "Funding")}</Th>{canPrepare && <Th />}</tr></thead>
                <tbody>{shown.map((o) => {
                  const u = unfundedBy.get(o.id);
                  const [label, tone]: [string, Tone] = u === undefined ? [L("ممول", "Funded"), "ok"] : !o.allocationCategoryId ? [L("بلا فئة — غير ممول", "No category — unfunded"), "bad"] : [L(`غير ممول ${money(u)}`, `Unfunded ${money(u)}`), "bad"];
                  return (
                    <tr key={o.id}>
                      <Td className="text-brown whitespace-nowrap">{o.dueDate}</Td>
                      <Td className="font-medium">{o.description}{o.counterparty && <p className="text-[11px] text-brown-light">{o.counterparty}</p>}</Td>
                      <Td className="text-brown whitespace-nowrap">{L(TYPES[o.type][0], TYPES[o.type][1])}</Td>
                      <Td num className="font-bold">{money(o.remaining)}{o.paid > 0 && <p className="text-[11px] font-normal text-brown-light">{L("مدفوع", "Paid")} {money(o.paid)}</p>}</Td>
                      <Td><Badge tone={tone}>{label}</Badge>{o.reserved > 0 && <p className="text-[11px] text-brown-light mt-0.5">{L("محجوز", "Reserved")} {money(o.reserved)}</p>}</Td>
                      {canPrepare && <Td><div className="flex gap-1 justify-end">
                        {o.type === "PURCHASE_ORDER" && o.status === "OPEN" && <Button kind="ghost" icon={Replace} onClick={() => setSupersede(o)} title={L("استبدال بفاتورة المورد", "Replace with the supplier bill")}>{L("فاتورة", "Bill")}</Button>}
                        {o.paid === 0 && <Button kind="ghost" icon={XCircle} title={L("إلغاء", "Cancel")} onClick={async () => { const reason = prompt(L("سبب الإلغاء", "Reason for cancelling")); if (!reason) return; try { await api(withBranch(`/api/finance/obligations/${o.id}/cancel`, branch), { method: "POST", json: { reason } }); reloadAll(); } catch (e) { alert((e as Error).message); } }}>{""}</Button>}
                      </div></Td>}
                    </tr>
                  );
                })}</tbody>
              </Table>
              <div className="flex items-center justify-between">
                <p className="text-xs text-brown">{L(`عرض ${shown.length} من ${rows.length} · الالتزام المستبدل (أمر الشراء) لا يُحتسب مرة ثانية`, `Showing ${shown.length} of ${rows.length} · a superseded purchase order is never counted twice`)}</p>
                {rows.length > 8 && <button type="button" className="text-xs font-bold text-orange" onClick={() => setShowAll(!showAll)}>{showAll ? L("عرض أقل", "Show fewer") : L("عرض الكل", "Show all")}</button>}
              </div>
            </>
          )}
        </Card>

        <Card pad="p-4">
          <CardTitle title={L("المتحصلات المتوقعة", "Expected receipts")} sub={L("ليست نقداً حتى وصولها", "Not cash until they arrive")} />
          {items.loading && !items.data ? <LoadingState /> : (items.data ?? []).filter((i) => i.kind === "RECEIPT").length === 0 ? <p className="text-[13px] text-brown">{L("لا توجد متحصلات متوقعة.", "No expected receipts.")}</p> : (
            <>
              <Table>
                <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("البند", "Item")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
                <tbody>{(items.data ?? []).filter((i) => i.kind === "RECEIPT").slice(0, 6).map((i) => (
                  <tr key={i.id}><Td className="text-brown whitespace-nowrap">{i.expectedDate.slice(0, 10)}</Td><Td>{i.description}</Td><Td num className="font-bold text-green-600">{money(Math.round(Number(i.amount) * 100))}</Td></tr>
                ))}</tbody>
              </Table>
              <p className="text-xs text-brown">{L(`${(items.data ?? []).filter((i) => i.kind === "RECEIPT").length} بنداً مفتوحاً خلال 13 أسبوعاً`, `${(items.data ?? []).filter((i) => i.kind === "RECEIPT").length} open items within 13 weeks`)}</p>
            </>
          )}
        </Card>
      </div>

      <ObligationDialog open={dlg === "ob"} onClose={() => setDlg(null)} setup={setup.data} cats={cats.data ?? []} onDone={reloadAll} />
      <ItemDialog open={dlg === "item"} onClose={() => setDlg(null)} setup={setup.data} onDone={reloadAll} />
      <SupersedeDialog ob={supersede} onClose={() => setSupersede(null)} onDone={reloadAll} />
    </div>
  );
}

function ObligationDialog({ open, onClose, setup, cats, onDone }: { open: boolean; onClose: () => void; setup: Setup | null; cats: Cat[]; onDone: () => void }) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const [f, setF] = useState({ type: "SUPPLIER_BILL", description: "", counterparty: "", amount: "", dueDate: "", branchKey: "COMPANY", allocationCategoryId: "", finCategoryId: "", repeatMonths: "1" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch("/api/finance/obligations", branch), { method: "POST", json: { ...f, allocationCategoryId: f.allocationCategoryId || undefined, finCategoryId: f.finCategoryId || undefined, repeatMonths: Number(f.repeatMonths) } }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} width="max-w-[640px]" title={L("التزام جديد", "New obligation")} sub={L("ما تدين به الشركة وموعده. الرواتب والإيجار تُكرر شهرياً عند الحاجة.", "What the company owes and when. Payroll and rent can repeat monthly.")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("النوع", "Type")}><select className={INPUT} value={f.type} onChange={set("type")}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{L(v[0], v[1])}</option>)}</select></Field>
        <Field label={L("النطاق", "Scope")}><select className={INPUT} value={f.branchKey} onChange={set("branchKey")}>{setup?.scope.all && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}{setup?.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
        <Field label={L("الوصف", "Description")}><input className={INPUT} value={f.description} onChange={set("description")} /></Field>
        <Field label={L("الطرف", "Counterparty")}><input className={INPUT} value={f.counterparty} onChange={set("counterparty")} /></Field>
        <Field label={L("المبلغ", "Amount")}><input className={INPUT} value={f.amount} onChange={set("amount")} inputMode="decimal" /></Field>
        <Field label={L("تاريخ الاستحقاق", "Due date")}><input type="date" className={INPUT} value={f.dueDate} onChange={set("dueDate")} /></Field>
        <Field label={L("فئة التمويل", "Funding category")}><select className={INPUT} value={f.allocationCategoryId} onChange={set("allocationCategoryId")}><option value="">—</option>{cats.filter((c) => c.branchKey === f.branchKey).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
        <Field label={L("بند الميزانية", "Budget category")}><select className={INPUT} value={f.finCategoryId} onChange={set("finCategoryId")}><option value="">—</option>{setup?.finCategories.filter((c) => c.kind === "PAYMENT").map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
        <Field label={L("تكرار شهري (عدد الأشهر)", "Repeat monthly (months)")}><input className={INPUT} value={f.repeatMonths} onChange={set("repeatMonths")} inputMode="numeric" /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("حفظ", "Save")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function ItemDialog({ open, onClose, setup, onDone }: { open: boolean; onClose: () => void; setup: Setup | null; onDone: () => void }) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const [f, setF] = useState({ kind: "RECEIPT", description: "", counterparty: "", amount: "", expectedDate: "", finCategoryId: "", branchKey: "COMPANY" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch("/api/finance/forecast-items", branch), { method: "POST", json: { ...f, finCategoryId: f.finCategoryId || undefined } }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={L("بند متوقع", "Expected item")} sub={L("متحصل أو مدفوع متوقع غير مسجّل كالتزام. لا يُحتسب نقداً.", "An expected receipt or payment that is not an obligation. Never counted as cash.")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("النوع", "Kind")}><select className={INPUT} value={f.kind} onChange={set("kind")}><option value="RECEIPT">{L("متحصل متوقع", "Expected receipt")}</option><option value="PAYMENT">{L("مدفوع متوقع", "Expected payment")}</option></select></Field>
        <Field label={L("النطاق", "Scope")}><select className={INPUT} value={f.branchKey} onChange={set("branchKey")}>{setup?.scope.all && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}{setup?.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
        <Field label={L("الوصف", "Description")}><input className={INPUT} value={f.description} onChange={set("description")} /></Field>
        <Field label={L("المبلغ", "Amount")}><input className={INPUT} value={f.amount} onChange={set("amount")} inputMode="decimal" /></Field>
        <Field label={L("التاريخ المتوقع", "Expected date")}><input type="date" className={INPUT} value={f.expectedDate} onChange={set("expectedDate")} /></Field>
        <Field label={L("بند الميزانية", "Budget category")}><select className={INPUT} value={f.finCategoryId} onChange={set("finCategoryId")}><option value="">—</option>{setup?.finCategories.filter((c) => c.kind === f.kind).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("حفظ", "Save")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function SupersedeDialog({ ob, onClose, onDone }: { ob: Ob | null; onClose: () => void; onDone: () => void }) {
  const { L } = useL();
  const { branch } = useFinance();
  const [amount, setAmount] = useState(""); const [dueDate, setDue] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!ob) return null;
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch(`/api/finance/obligations/${ob!.id}/supersede`, branch), { method: "POST", json: { amount: amount || undefined, dueDate: dueDate || undefined } }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!ob} onClose={onClose} title={L("استبدال أمر الشراء بفاتورة المورد", "Replace the purchase order with the supplier bill")} sub={L("تحل الفاتورة محل أمر الشراء فلا يُحتسب الالتزام مرتين؛ الحجوزات تنتقل إلى الفاتورة.", "The bill replaces the order so the obligation is never counted twice; reservations move to the bill.")}>
      <p className="text-[13px] font-bold">{ob.description} · {(ob.amount / 100).toFixed(2)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("مبلغ الفاتورة", "Bill amount")}><input className={INPUT} placeholder={(ob.amount / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
        <Field label={L("تاريخ الاستحقاق", "Due date")}><input type="date" className={INPUT} value={dueDate} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("استبدال", "Replace")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}
