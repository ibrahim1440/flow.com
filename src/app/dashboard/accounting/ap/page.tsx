"use client";

// «الذمم الدائنة» (Figma ACC-50 · ACC-53): purchase invoices (the purchases screen's documents, phase 2), AP aging with the supplier statement (from the books,
// checked against the AP control account), and supplier payments (record — applied in full to posted invoices —
// and void). The API re-checks every duty (accounting › ap for payments, with a step-up).
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsLoading, Btn, Notice } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { LEGACY_AP_TAB } from "@/lib/accounting/source-links";
import { AcctShell, Msg, money, todayRiyadh, useApi, useLang, useWrite, type Setup } from "../_ui/shell";
import { InvoiceList, type InvoiceRow } from "../_ui/ap";

type Aging = { asOf: string; total: string; buckets: Record<string, string>; counts: Record<string, number>; suppliers: { supplierId: string; name: string; buckets: Record<string, string>; total: string; openClaim?: string }[]; openClaims?: string; gl: { balance: string; difference: string } | null };
type Statement = { supplier: { name: string }; from: string; to: string; opening: string; closing: string; lines: { entryId: string; date: string; ref: string; description: string | null; sourceType: string | null; debit: string; credit: string; balance: string }[] };
type Payment = { id: string; number: string; supplierName: string; paymentDate: string; amount: string; method: string; reference: string | null; status: string; journalEntryId: string | null; invoices: string[] };
type Supplier = { id: string; name: string; openingOutstanding?: string };
type List = { rows: InvoiceRow[]; can: { ap: boolean } };
const BUCKETS: [string, string, string][] = [["current", "غير مستحقة", "Not due"], ["d1_30", "1–30 يومًا", "1–30 days"], ["d31_60", "31–60 يومًا", "31–60 days"], ["d61_90", "61–90 يومًا", "61–90 days"], ["d90_plus", "أكثر من 90", "Over 90"]];
const METHOD: Record<string, [string, string]> = { BANK_TRANSFER: ["تحويل بنكي", "Bank transfer"], CASH: ["نقدًا", "Cash"], CHEQUE: ["شيك", "Cheque"] };

function Ap() {
  const { L } = useLang();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  // An old address (?tab=payments|reconciliation…, before phase 4) lands on the view that holds it now.
  const legacy = sp.get("tab");
  const asked = sp.get("view") ?? (legacy ? LEGACY_AP_TAB[legacy] ?? null : null);
  const view = asked === "aging" ? "aging" : asked === "payments" ? "payments" : "invoices";
  useEffect(() => {
    if (!legacy) return;
    const p = new URLSearchParams(sp.toString());
    p.delete("tab");
    const v = LEGACY_AP_TAB[legacy];
    if (v && v !== "invoices") p.set("view", v);
    router.replace(p.toString() ? `${path}?${p}` : path);
  }, [legacy, path, router, sp]);
  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") p.delete(k); else p.set(k, v); }
    router.replace(`${path}?${p}`);
  };
  const setup = useApi<Setup>("/api/accounting/setup");
  return (
    <AcctShell setup={setup.data} title={L("الذمم الدائنة", "Accounts payable")}
      actions={<Link className="hr-btn is-primary" href="/dashboard/purchases/invoices/new" data-testid="ap-new-invoice">+ {L("فاتورة مشتريات", "Purchase invoice")}</Link>}>
      <div className="acct-row">
        <div className="acct-seg" role="group" aria-label={L("القسم", "Section")}>
          <button type="button" aria-pressed={view === "invoices"} onClick={() => go({ view: null })} data-testid="ap-view-invoices">{L("فواتير المشتريات", "Purchase invoices")}</button>
          <button type="button" aria-pressed={view === "aging"} onClick={() => go({ view: "aging" })} data-testid="ap-view-aging">{L("أعمار الدائنين وكشف المورد", "AP aging & statement")}</button>
          <button type="button" aria-pressed={view === "payments"} onClick={() => go({ view: "payments" })} data-testid="ap-view-payments">{L("المدفوعات", "Payments")}</button>
        </div>
      </div>
      {view === "invoices" ? <InvoiceList base="/dashboard/purchases/invoices" /> : view === "aging" ? <AgingView asOf={sp.get("asOf") ?? todayRiyadh()} supplierId={sp.get("supplierId") ?? ""} go={go} /> : <PaymentsView />}
    </AcctShell>
  );
}

function AgingView({ asOf, supplierId, go }: { asOf: string; supplierId: string; go: (p: Record<string, string | null>) => void }) {
  const { L } = useLang();
  const sups = useApi<Supplier[]>("/api/accounting/ap/suppliers");
  const aging = useApi<Aging>(`/api/accounting/ap/aging?asOf=${asOf}${supplierId ? `&supplierId=${supplierId}` : ""}`);
  const stSup = supplierId || aging.data?.suppliers[0]?.supplierId || "";
  const st = useApi<Statement>(stSup ? `/api/accounting/ap/statement?supplierId=${stSup}&to=${asOf}` : null);
  return (
    <>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("كما في", "As of")}</span><input type="date" className="hr-input" value={asOf} onChange={(e) => e.target.value && go({ asOf: e.target.value })} data-testid="aging-asof" /></label>
        <label className="hr-field acct-grow"><span className="hr-label">{L("المورد", "Supplier")}</span>
          <Select value={supplierId} onChange={(e) => go({ supplierId: e.target.value })}><option value="">{L("الكل", "All")}</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
        <a className="hr-btn" href={`/api/accounting/ap/aging?asOf=${asOf}&format=csv`}>{L("تصدير CSV", "Export CSV")}</a>
      </div>
      {aging.error ? <p role="alert" className="hr-err">{aging.error}</p> : !aging.data ? <OpsLoading /> : (
        <>
          {aging.data.gl ? <p className={`acct-balanced ${Number(aging.data.gl.difference) ? "is-bad" : "is-ok"}`} data-testid="aging-gl">● {Number(aging.data.gl.difference) ? L("غير مطابق لحساب الذمم الدائنة", "Not matching the AP account") : L("مطابق لحساب الذمم الدائنة", "Matches the AP account")} · {L("الأعمار", "Aging")} <span className="hr-num">{money(aging.data.total)}</span> = {L("دفتر الأستاذ", "Ledger")} <span className="hr-num">{money(aging.data.gl.balance)}</span> · {L("الفرق", "Difference")} <span className="hr-num">{money(aging.data.gl.difference)}</span></p> : null}
          <div className="acct-metrics" data-testid="aging-buckets">
            {BUCKETS.map(([k, ar, en]) => <div key={k} className="acct-metric"><span className="k">{L(ar, en)}</span><span className={`v${k === "d90_plus" && Number(aging.data!.buckets[k]) ? " is-bad" : ""}`}>{money(aging.data!.buckets[k])}</span><span className="s">{L(`${aging.data!.counts[k] ?? 0} فاتورة`, `${aging.data!.counts[k] ?? 0} invoices`)}</span></div>)}
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="aging-table">
              <thead><tr><th>{L("المورد", "Supplier")}</th>{BUCKETS.map(([k, ar, en]) => <th key={k} className={`num${k === "current" ? "" : " acct-hide-m"}`}>{L(ar, en)}</th>)}<th className="num">{L("الإجمالي", "Total")}</th><th className="num">{L("مطالبة مفتوحة", "Open claim")}</th></tr></thead>
              <tbody>
                {aging.data.suppliers.map((s) => (
                  <tr key={s.supplierId} className="is-clickable" onClick={() => go({ supplierId: s.supplierId })}>
                    <td>{s.name}</td>{BUCKETS.map(([k]) => <td key={k} className={`num hr-num${k === "current" ? "" : " acct-hide-m"}`}>{money(s.buckets[k], true)}</td>)}<td className="num hr-num">{money(s.total)}</td>
                    <td className="num hr-num" data-testid={`aging-claim-${s.supplierId}`}>{Number(s.openClaim ?? 0) ? <span className="acct-bad">{money(s.openClaim)}</span> : <span className="hr-caption">—</span>}</td>
                  </tr>
                ))}
                <tr className="is-total"><td>{L("الإجمالي", "Total")}</td>{BUCKETS.map(([k]) => <td key={k} className={`num hr-num${k === "current" ? "" : " acct-hide-m"}`}>{money(aging.data!.buckets[k])}</td>)}<td className="num hr-num" data-testid="aging-total">{money(aging.data.total)}</td><td className="num hr-num" data-testid="aging-claims-total">{money(aging.data.openClaims ?? 0)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      {st.data ? (
        <section className="acct-card" data-testid="statement">
          <h2>{L("كشف حساب", "Statement")} · {st.data.supplier.name} <span className="acct-hint hr-num">{st.data.from} – {st.data.to} · {L("الرصيد", "Balance")} {money(st.data.closing)}</span></h2>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense">
              <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("المستند", "Document")}</th><th className="acct-hide-m">{L("البيان", "Description")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
              <tbody>
                <tr className="is-header"><td className="hr-num">{st.data.from}</td><td /><td className="acct-hide-m">{L("رصيد أول المدة", "Opening balance")}</td><td /><td /><td className="num hr-num">{money(st.data.opening)}</td></tr>
                {st.data.lines.map((l, i) => <tr key={i}><td className="hr-num">{l.date}</td><td><Link className="acct-code" href={`/dashboard/accounting/journals/${l.entryId}`}>{l.ref}</Link></td><td className="acct-hide-m">{l.description}</td><td className="num hr-num">{money(l.debit, true)}</td><td className="num hr-num">{money(l.credit, true)}</td><td className="num hr-num">{money(l.balance)}</td></tr>)}
                <tr className="is-total"><td className="hr-num">{st.data.to}</td><td /><td className="acct-hide-m">{L("الرصيد الختامي", "Closing balance")}</td><td /><td /><td className="num hr-num">{money(st.data.closing)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="acct-hint">{L("الأعمار من الفواتير المرحّلة حتى التاريخ المحدد، والكشف من القيود المرحّلة على حساب الذمم الدائنة لهذا المورد.", "Aging is from the posted invoices up to the date; the statement from the posted entries on the AP account for this supplier.")}</p>
        </section>
      ) : null}
    </>
  );
}

function PaymentsView() {
  const { L } = useLang();
  const pays = useApi<Payment[]>("/api/accounting/ap/payments");
  const sups = useApi<Supplier[]>("/api/accounting/ap/suppliers");
  const w = useWrite();
  const [open, setOpen] = useState(false);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [reason, setReason] = useState("");
  const [f, setF] = useState({ supplierId: "", paymentDate: todayRiyadh(), method: "BANK_TRANSFER", reference: "", alloc: {} as Record<string, string> });
  const inv = useApi<List>(f.supplierId ? `/api/accounting/ap/invoices?status=POSTED&supplierId=${f.supplierId}` : null);
  const openInv = (inv.data?.rows ?? []).filter((r) => Number(r.outstanding) > 0);
  // «نقص من المورد»: the supplier's open claims — pay what the invoice owes less what the supplier still owes back.
  const claims = useApi<{ rows: { invoice: { id: string }; openGross: string }[]; openGross: string }>(f.supplierId ? `/api/purchases/claims?supplierId=${f.supplierId}` : null);
  const claimOn = (invoiceId: string) => (claims.data?.rows ?? []).filter((c) => c.invoice.id === invoiceId).reduce((a, c) => a + Number(c.openGross), 0);
  // A5: the part paying the supplier's opening balance (no invoice in the system), capped by what it still owes.
  const [toOpening, setToOpening] = useState("");
  const openingOutstanding = Number((sups.data ?? []).find((s) => s.id === f.supplierId)?.openingOutstanding ?? 0);
  const total = Object.values(f.alloc).reduce((s, v) => s + (Number(v) || 0), 0) + (Number(toOpening) || 0);
  async function record() {
    const allocations = Object.entries(f.alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount).toFixed(2) }));
    if (await w.run("pay", "/api/accounting/ap/payments", "POST", { supplierId: f.supplierId, paymentDate: f.paymentDate, method: f.method, reference: f.reference || null, amount: total.toFixed(2), allocations }, L("سُجّل السداد ورُحّل.", "Payment recorded and posted."))) {
      setOpen(false); setF({ ...f, alloc: {}, reference: "" }); setToOpening(""); pays.reload(); sups.reload();
    }
  }
  return (
    <>
      <Msg error={w.error ?? pays.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <div className="acct-actions"><Btn variant="primary" onClick={() => setOpen(true)} data-testid="pay-new">+ {L("تسجيل سداد", "Record a payment")}</Btn></div>
      {!pays.data ? <OpsLoading /> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="payments">
            <thead><tr><th>{L("السداد", "Payment")}</th><th>{L("المورد", "Supplier")}</th><th className="acct-hide-m">{L("التاريخ", "Date")}</th><th className="acct-hide-m">{L("الطريقة", "Method")}</th><th className="acct-hide-m">{L("الفواتير", "Invoices")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{L("الحالة", "Status")}</th><th /></tr></thead>
            <tbody>
              {pays.data.map((p) => (
                <tr key={p.id} className={p.status === "VOIDED" ? "is-muted" : undefined}>
                  <td>{p.journalEntryId ? <Link className="acct-code" href={`/dashboard/accounting/journals/${p.journalEntryId}`}>{p.number}</Link> : <span className="acct-code">{p.number}</span>}</td>
                  <td>{p.supplierName}</td><td className="acct-hide-m hr-num">{p.paymentDate}</td><td className="acct-hide-m">{L(METHOD[p.method]?.[0] ?? p.method, METHOD[p.method]?.[1] ?? p.method)}{p.reference ? ` · ${p.reference}` : ""}</td>
                  <td className="acct-hide-m acct-code">{p.invoices.join(" ، ")}</td><td className="num hr-num">{money(p.amount)}</td>
                  <td>{p.status === "VOIDED" ? <span className="hr-dot tone-cancelled"><span>{L("ملغى", "Voided")}</span></span> : <span className="hr-dot tone-success"><span>{L("مرحّل", "Posted")}</span></span>}</td>
                  <td>{p.status === "POSTED" ? <Btn size="sm" variant="ghost" onClick={() => setVoiding(p)}>{L("إلغاء", "Void")}</Btn> : null}</td>
                </tr>
              ))}
              {!pays.data.length ? <tr><td colSpan={8} className="acct-hint">{L("لا مدفوعات بعد.", "No payments yet.")}</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={open} title={L("تسجيل سداد لمورد", "Record a supplier payment")} onClose={() => setOpen(false)}
        actions={<><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={w.busy === "pay"} disabled={!f.supplierId || total <= 0} onClick={record} data-testid="pay-confirm">{L(`سداد ${money(total)} ر.س`, `Pay SAR ${money(total)}`)}</Btn></>}>
        <div className="hr-stack">
          <label className="hr-field"><span className="hr-label">{L("المورد", "Supplier")}</span><Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value, alloc: {} })} data-testid="pay-supplier"><option value="">{L("اختر المورد", "Choose the supplier")}</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("التاريخ", "Date")}</span><input type="date" className="hr-input" value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} /></label>
            <label className="hr-field"><span className="hr-label">{L("الطريقة", "Method")}</span><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHOD).map(([k, [ar, en]]) => <option key={k} value={k}>{L(ar, en)}</option>)}</Select></label>
            <label className="hr-field"><span className="hr-label">{L("المرجع", "Reference")}</span><input className="hr-input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
          </div>
          {f.supplierId && Number(claims.data?.openGross ?? 0) > 0 ? <Notice tone="warning"><span data-testid="pay-claim-warning">{L(`لدى هذا المورد مطالبات مفتوحة بقيمة ${money(claims.data?.openGross)} ر.س (نقص فوترَه ولم يصل). انتظر إشعاره الدائن أو اخصمها قبل سداد كامل الفاتورة.`, `This supplier has open claims of SAR ${money(claims.data?.openGross)} (billed, not delivered). Wait for its credit note or hold it back before paying the invoice in full.`)}</span></Notice> : null}
          {f.supplierId ? (openInv.length ? (
            <table className="hr-table is-dense"><thead><tr><th>{L("الفاتورة", "Invoice")}</th><th className="num">{L("المتبقي", "Open")}</th><th className="num">{L("المسدَّد", "Apply")}</th></tr></thead>
              <tbody>{openInv.map((r) => <tr key={r.id}><td className="acct-code">{r.number} · {r.supplierRef}{claimOn(r.id) ? <span className="hr-caption"> · {L(`مطالبة ${money(claimOn(r.id))}`, `claim ${money(claimOn(r.id))}`)}</span> : null}</td><td className="num hr-num">{money(r.outstanding)}</td><td className="num"><input className="hr-input acct-amount" style={{ width: 110 }} inputMode="decimal" value={f.alloc[r.id] ?? ""} placeholder={r.outstanding} onChange={(e) => setF({ ...f, alloc: { ...f.alloc, [r.id]: e.target.value } })} data-testid={`pay-alloc-${r.number}`} /></td></tr>)}</tbody></table>
          ) : <p className="acct-hint">{L("لا فواتير مرحّلة مفتوحة لهذا المورد.", "No open posted invoices for this supplier.")}</p>) : null}
          {f.supplierId && openingOutstanding > 0 ? (
            <label className="hr-field"><span className="hr-label">{L(`من الرصيد الافتتاحي (المتبقي ${money(openingOutstanding)})`, `Against the opening balance (open ${money(openingOutstanding)})`)}</span>
              <input className="hr-input acct-amount" inputMode="decimal" value={toOpening} onChange={(e) => setToOpening(e.target.value)} data-testid="pay-opening" /></label>
          ) : null}
          <p className="acct-hint">{L("يُطبَّق المبلغ على الفواتير (والباقي على الرصيد الافتتاحي)، ويُرحَّل: مدين الذمم الدائنة / دائن البنك (أو الصندوق).", "The amount is applied to invoices (the rest to the opening balance) and posted: Dr accounts payable / Cr bank (or cash).")}</p>
        </div>
      </Dialog>
      <Dialog open={!!voiding} title={L("إلغاء السداد", "Void the payment")} onClose={() => setVoiding(null)}
        actions={<><Btn onClick={() => setVoiding(null)}>{L("رجوع", "Back")}</Btn><Btn variant="danger" busy={w.busy === "void"} disabled={reason.trim().length < 3} onClick={async () => { if (voiding && await w.run("void", `/api/accounting/ap/payments/${voiding.id}/void`, "POST", { reason }, L("أُلغي السداد وعُكس قيده.", "Voided; its entry is reversed."))) { setVoiding(null); setReason(""); pays.reload(); } }}>{L("تأكيد", "Confirm")}</Btn></>}>
        <p>{voiding ? L(`يُعكس قيد ${voiding.number} وتعود الفواتير مستحقة.`, `${voiding.number}'s entry is reversed and its invoices owe again.`) : null}</p>
        <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </Dialog>
    </>
  );
}

export default function ApPage() {
  return <Suspense fallback={<OpsLoading />}><Ap /></Suspense>;
}
