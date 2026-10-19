"use client";

import { useState } from "react";
import { useUser } from "../../user-context";
import { Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, Kpi, LoadingState, Metrics, Notice, Status, Table, Td, Th, api, useApi, useFinance, useHasSub, useL, withBranch, type Tone } from "../_components/ui";

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
  const [cancelling, setCancelling] = useState<Ob | null>(null);
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
    <>
      <Metrics cols={4}>
        <Kpi label={L("النقد الافتتاحي (مؤكد، غير مقيد)", "Opening cash (confirmed, unrestricted)")} value={money(f.opening)} sub={L(`بداية الأسبوع ${ddmm(f.base.weeks[0].start)}`, `Week starting ${ddmm(f.base.weeks[0].start)}`)} />
        <Kpi label={L("أدنى رصيد متوقع", "Lowest projected balance")} value={money(f.base.lowestClosing)} sub={lowW ? L(`الأسبوع ${lowW.index} · ${ddmm(lowW.start)} – ${ddmm(lowW.end)}`, `Week ${lowW.index} · ${ddmm(lowW.start)} – ${ddmm(lowW.end)}`) : undefined} valueClass={f.base.lowestClosing < 0 ? "is-danger" : ""} />
        <Kpi label={L("أول عجز متوقع", "First projected shortfall")} value={f.base.firstShortfallWeek ? L(`الأسبوع ${f.base.firstShortfallWeek}`, `Week ${f.base.firstShortfallWeek}`) : L("لا يوجد", "None")} valueClass={f.base.firstShortfallWeek ? "is-danger" : "is-success"} sub={L(`المتحفظ: ${shortfall(f.conservative.firstShortfallWeek, f.conservative.lowestClosing)}`, `Conservative: ${shortfall(f.conservative.firstShortfallWeek, f.conservative.lowestClosing)}`)} />
        <Kpi label={L("التزامات غير ممولة", "Unfunded obligations")} value={money(ov.data?.unfundedTotal ?? 0)} valueClass="is-danger" sub={L(`${ov.data?.unfunded.length ?? 0} التزاماً`, `${ov.data?.unfunded.length ?? 0} obligations`)} />
      </Metrics>

      <Card>
        <CardTitle title={L("التوقع النقدي المتجدد — 13 أسبوعاً", "Rolling cash forecast — 13 weeks")}
          sub={L(`الختامي لكل أسبوع هو افتتاحي الأسبوع التالي · المتحفظ: تأخر التحصيل ${f.assumptions.conservativeDelayWeeks} أسبوع وتحصيل ${f.assumptions.conservativeCollectPct}%`, `Each week's closing is the next week's opening · conservative: collections ${f.assumptions.conservativeDelayWeeks} weeks late at ${f.assumptions.conservativeCollectPct}%`)}
          right={<>
            <a href={withBranch("/api/finance/export?kind=forecast&format=xlsx", branch)} className="hr-btn is-ghost is-sm">{L("تصدير", "Export")}</a>
            {canPrepare && <Button size="sm" onClick={() => setDlg("item")}>{L("بند متوقع", "Expected item")}</Button>}
            {canPrepare && <Button size="sm" kind="primary" onClick={() => setDlg("ob")}>{L("التزام جديد", "New obligation")}</Button>}
          </>} />
        <Table className="is-mrow" label={L("التوقع النقدي المتجدد", "Rolling cash forecast")}>
          <thead><tr><Th>{L("الأسبوع", "Week")}</Th><Th>{L("يبدأ", "Starts")}</Th><Th num>{L("الافتتاحي", "Opening")}</Th><Th num>{L("مقبوضات متوقعة", "Expected receipts")}</Th><Th num>{L("مدفوعات متوقعة", "Expected payments")}</Th><Th num>{L("الختامي", "Closing")}</Th><Th num>{L("الختامي (متحفظ)", "Closing (conservative)")}</Th></tr></thead>
          <tbody>{f.base.weeks.map((w, i) => {
            const c = f.conservative.weeks[i];
            return (
              <tr key={w.index} className={w.index === f.base.lowestWeek ? "is-hl" : ""}>
                <Td className="hr-num">{w.index}</Td><Td className="m-title"><span className="hr-num">{ddmm(w.start)}</span><span className="hr-msub">{L("الأسبوع", "Week")} {w.index} · {L("متحفظ", "conservative")} {money(c.closing)}</span></Td><Td num className="fin-t2">{money(w.opening)}</Td>
                <Td num className="fin-success">{money(w.receipts)}</Td><Td num>{money(w.payments)}</Td>
                <Td num className={`m-end fin-strong ${w.closing < 0 ? "fin-danger" : ""}`}>{money(w.closing)}</Td><Td num className={c.closing < 0 ? "fin-danger fin-strong" : "fin-t2"}>{money(c.closing)}</Td>
              </tr>
            );
          })}</tbody>
        </Table>
        <p className="fin-foot">{L("المدفوعات = الالتزامات المفتوحة (المتبقي فقط، دون المستبدلة) + طلبات دفع غير مرتبطة بالتزام + مدفوعات متوقعة أخرى. التخصيصات الداخلية لا تُخصم.", "Payments = open obligations (remaining only, never superseded ones) + payment requests not tied to an obligation + other expected payments. Internal allocations are not deducted.")}</p>
      </Card>

      <Card className="is-ruled">
        <CardTitle title={L("الالتزامات المفتوحة", "Open obligations")} sub={L("مرتبة حسب الاستحقاق · التمويل من رصيد فئة التخصيص المرتبطة", "By due date · funded from the linked allocation category's balance")} />
        {obs.loading && !obs.data ? <LoadingState /> : obs.error ? <ErrorState error={obs.error} onRetry={obs.reload} /> : rows.length === 0 ? <EmptyState title={L("لا توجد التزامات مفتوحة", "No open obligations")} /> : (
          <>
            <Table className="is-mrow" label={L("الالتزامات المفتوحة", "Open obligations")}>
              <thead><tr><Th>{L("الاستحقاق", "Due")}</Th><Th>{L("الالتزام", "Obligation")}</Th><Th>{L("النوع", "Type")}</Th><Th num>{L("المتبقي", "Remaining")}</Th><Th>{L("التمويل", "Funding")}</Th>{canPrepare && <Th />}</tr></thead>
              <tbody>{shown.map((o) => {
                const u = unfundedBy.get(o.id);
                const [label, tone]: [string, Tone] = u === undefined ? [L("ممول", "Funded"), "ok"] : !o.allocationCategoryId ? [L("بلا فئة — غير ممول", "No category — unfunded"), "bad"] : [L(`غير ممول ${money(u)}`, `Unfunded ${money(u)}`), "bad"];
                return (
                  <tr key={o.id}>
                    <Td className="hr-num fin-t2">{o.dueDate}</Td>
                    <Td className="m-title fin-wrap"><span className="strong">{o.description}</span>{o.counterparty && <span className="fin-sub">{o.counterparty}</span>}<span className="hr-msub"><span className="hr-num">{o.dueDate}</span> · {L(TYPES[o.type][0], TYPES[o.type][1])} · <Status tone={tone}>{label}</Status></span></Td>
                    <Td className="fin-t2">{L(TYPES[o.type][0], TYPES[o.type][1])}</Td>
                    <Td num className="m-end">{money(o.remaining)}{o.paid > 0 && <span className="fin-sub">{L("مدفوع", "Paid")} {money(o.paid)}</span>}</Td>
                    <Td><Status tone={tone}>{label}</Status>{o.reserved > 0 && <span className="fin-sub">{L("محجوز", "Reserved")} {money(o.reserved)}</span>}</Td>
                    {canPrepare && <Td className="fin-acts stk-macts">
                      {o.type === "PURCHASE_ORDER" && o.status === "OPEN" && <Button size="sm" kind="ghost" onClick={() => setSupersede(o)} title={L("استبدال بفاتورة المورد", "Replace with the supplier bill")}>{L("فاتورة", "Bill")}</Button>}
                      <Button size="sm" kind="ghost" title={L("إلغاء الالتزام", "Cancel obligation")} onClick={() => setCancelling(o)}>{L("إلغاء", "Cancel")}</Button>
                    </Td>}
                  </tr>
                );
              })}</tbody>
            </Table>
            <div className="fin-row" style={{ justifyContent: "space-between" }}>
              <p className="fin-foot">{L(`عرض ${shown.length} من ${rows.length} · الالتزام المستبدل (أمر الشراء) لا يُحتسب مرة ثانية`, `Showing ${shown.length} of ${rows.length} · a superseded purchase order is never counted twice`)}</p>
              {rows.length > 8 && <button type="button" className="fin-lk" onClick={() => setShowAll(!showAll)}>{showAll ? L("عرض أقل", "Show fewer") : L("عرض الكل", "Show all")}</button>}
            </div>
          </>
        )}
      </Card>

      <Card className="is-ruled">
        <CardTitle title={L("المتحصلات المتوقعة", "Expected receipts")} sub={L("ليست نقداً حتى وصولها", "Not cash until they arrive")} />
        {items.loading && !items.data ? <LoadingState /> : (items.data ?? []).filter((i) => i.kind === "RECEIPT").length === 0 ? <p className="fin-cap">{L("لا توجد متحصلات متوقعة.", "No expected receipts.")}</p> : (
          <>
            <Table className="is-mrow" label={L("المتحصلات المتوقعة", "Expected receipts")}>
              <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("البند", "Item")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
              <tbody>{(items.data ?? []).filter((i) => i.kind === "RECEIPT").slice(0, 6).map((i) => (
                <tr key={i.id}><Td className="hr-num fin-t2">{i.expectedDate.slice(0, 10)}</Td><Td className="m-title fin-wrap"><span className="strong">{i.description}</span><span className="hr-msub hr-num">{i.expectedDate.slice(0, 10)}</span></Td><Td num className="m-end fin-success">{money(Math.round(Number(i.amount) * 100))}</Td></tr>
              ))}</tbody>
            </Table>
            <p className="fin-foot">{L(`${(items.data ?? []).filter((i) => i.kind === "RECEIPT").length} بنداً مفتوحاً خلال 13 أسبوعاً`, `${(items.data ?? []).filter((i) => i.kind === "RECEIPT").length} open items within 13 weeks`)}</p>
          </>
        )}
      </Card>

      <ObligationDialog open={dlg === "ob"} onClose={() => setDlg(null)} setup={setup.data} cats={cats.data ?? []} onDone={reloadAll} />
      <ItemDialog open={dlg === "item"} onClose={() => setDlg(null)} setup={setup.data} onDone={reloadAll} />
      <SupersedeDialog ob={supersede} onClose={() => setSupersede(null)} onDone={reloadAll} />
      <CancelDialog ob={cancelling} onClose={() => setCancelling(null)} onDone={reloadAll} />
    </>
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
      <div className="fin-grid">
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
      <div className="fin-row"><Button kind="primary" busy={busy} onClick={submit}>{L("حفظ", "Save")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
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
      <div className="fin-grid">
        <Field label={L("النوع", "Kind")}><select className={INPUT} value={f.kind} onChange={set("kind")}><option value="RECEIPT">{L("متحصل متوقع", "Expected receipt")}</option><option value="PAYMENT">{L("مدفوع متوقع", "Expected payment")}</option></select></Field>
        <Field label={L("النطاق", "Scope")}><select className={INPUT} value={f.branchKey} onChange={set("branchKey")}>{setup?.scope.all && <option value="COMPANY">{L("مستوى الشركة", "Company level")}</option>}{setup?.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}</select></Field>
        <Field label={L("الوصف", "Description")}><input className={INPUT} value={f.description} onChange={set("description")} /></Field>
        <Field label={L("المبلغ", "Amount")}><input className={INPUT} value={f.amount} onChange={set("amount")} inputMode="decimal" /></Field>
        <Field label={L("التاريخ المتوقع", "Expected date")}><input type="date" className={INPUT} value={f.expectedDate} onChange={set("expectedDate")} /></Field>
        <Field label={L("بند الميزانية", "Budget category")}><select className={INPUT} value={f.finCategoryId} onChange={set("finCategoryId")}><option value="">—</option>{setup?.finCategories.filter((c) => c.kind === f.kind).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}</select></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="fin-row"><Button kind="primary" busy={busy} onClick={submit}>{L("حفظ", "Save")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
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
      <p className="fin-strong fin-t1" style={{ margin: 0 }}>{ob.description} · {(ob.amount / 100).toFixed(2)}</p>
      <div className="fin-grid">
        <Field label={L("مبلغ الفاتورة", "Bill amount")}><input className={INPUT} placeholder={(ob.amount / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
        <Field label={L("تاريخ الاستحقاق", "Due date")}><input type="date" className={INPUT} value={dueDate} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="fin-row"><Button kind="primary" busy={busy} onClick={submit}>{L("استبدال", "Replace")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

type Effects = { amount: number; paid: number; remaining: number; reservations: { id: string; amount: number; status: string }[]; cancellable: boolean };

/** Cancelling shows what it touches first; a reason is required and recorded in the audit log. */
function CancelDialog({ ob, onClose, onDone }: { ob: Ob | null; onClose: () => void; onDone: () => void }) {
  const { L, money } = useL();
  const { branch } = useFinance();
  const user = useUser();
  const canAllocate = useHasSub(user?.permissions, "allocate");
  const fx = useApi<Effects>(ob ? withBranch(`/api/finance/obligations/${ob.id}/cancel`, branch) : null);
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  if (!ob) return null;
  const close = () => { setReason(""); setErr(null); onClose(); };
  const e = fx.data;
  const held = e ? e.reservations.reduce((t, r) => t + r.amount, 0) : 0;
  const blocked = !!e && e.reservations.length > 0 && !canAllocate;
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch(`/api/finance/obligations/${ob!.id}/cancel`, branch), { method: "POST", json: { reason } }); onDone(); close(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!ob} onClose={close} title={L("إلغاء الالتزام", "Cancel obligation")} sub={`${ob.description}${ob.counterparty ? ` · ${ob.counterparty}` : ""}`}>
      {!e ? <LoadingState /> : (
        <div data-testid="cancel-effects" className="fin-stack" style={{ fontSize: 13.5 }}>
          <p>{L("يتوقف احتساب المتبقي في التوقع والتنبيهات", "The remaining amount stops counting in the forecast and alerts")}: <b className="fin-num">{money(e.remaining)}</b></p>
          {e.paid > 0 && <p>{L("المدفوع يبقى مسجلاً ومطابقاً (نقد خرج فعلاً ولا يُعكس هنا)", "What was paid stays recorded and matched (cash that left is not reversed here)")}: <b className="fin-num">{money(e.paid)}</b></p>}
          {e.reservations.length > 0 && <p>{L(`${e.reservations.length} طلب دفع مفتوح يُحرَّر ويعود مبلغه إلى الفئة بقيد تحرير مسجّل`, `${e.reservations.length} open payment request(s) are released and their money returns to the category with a recorded release`)}: <b className="fin-num">{money(held)}</b></p>}
        </div>
      )}
      {blocked && <Notice tone="warn">{L("تحرير طلبات الدفع يتطلب صلاحية التخصيص؛ اطلب ذلك من صاحبها.", "Releasing payment requests needs the allocate duty; ask a holder of that duty.")}</Notice>}
      <Field label={L("سبب الإلغاء (مطلوب)", "Reason for cancelling (required)")}><textarea className={INPUT} rows={2} value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="fin-row"><Button kind="danger" busy={busy} disabled={!e || blocked || reason.trim().length < 5} onClick={submit}>{L("تأكيد الإلغاء", "Confirm cancellation")}</Button><Button onClick={close}>{L("رجوع", "Back")}</Button></div>
    </Dialog>
  );
}
