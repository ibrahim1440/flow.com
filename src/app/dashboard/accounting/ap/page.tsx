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
import { DateRange, FilterCard, Section, ListFooter, ListPageSize, useFilters, usePaging, useTerm } from "@/components/chrome";
import { useAccountantView } from "../_ui/qoyod-pages";
import { LocationFilter, UNASSIGNED_LOCATION, useLocations } from "../_ui/locations";
import { FormField, PartyCard } from "@/components/forms/QoyodForm";
import { allocateOldestFirst } from "@/lib/purchases/allocation";


type Aging = { asOf: string; total: string; buckets: Record<string, string>; counts: Record<string, number>; suppliers: { supplierId: string; name: string; buckets: Record<string, string>; total: string; openClaim?: string }[]; openClaims?: string; gl: { balance: string; difference: string } | null };
type Statement = { supplier: { name: string }; from: string; to: string; opening: string; closing: string; lines: { entryId: string; date: string; ref: string; description: string | null; sourceType: string | null; debit: string; credit: string; balance: string }[] };
type Payment = { id: string; number: string; supplierName: string; paymentDate: string; amount: string; method: string; reference: string | null; status: string; journalEntryId: string | null; invoices: string[]; allocated?: string; supplierId: string; branchId?: string | null };
type Supplier = { id: string; name: string; vatNumber?: string | null; openingOutstanding?: string };
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
  const qoyod = useAccountantView();
  const t = useTerm();
  return (
    <AcctShell setup={setup.data} title={L("الذمم الدائنة", "Accounts payable")}
      actions={<Link className="hr-btn is-primary" href="/dashboard/purchases/invoices/new" data-testid="ap-new-invoice">+ {L("فاتورة مشتريات", "Purchase invoice")}</Link>}>
      <div className="acct-row">
        <div className="acct-seg" role="group" aria-label={L("القسم", "Section")}>
          <button type="button" aria-pressed={view === "invoices"} onClick={() => go({ view: null })} data-testid="ap-view-invoices">{L("فواتير المشتريات", "Purchase invoices")}</button>
          <button type="button" aria-pressed={view === "aging"} onClick={() => go({ view: "aging" })} data-testid="ap-view-aging">{L("أعمار الدائنين وكشف المورد", "AP aging & statement")}</button>
          <button type="button" aria-pressed={view === "payments"} onClick={() => go({ view: "payments" })} data-testid="ap-view-payments">{qoyod ? t("supplierPayments") : L("المدفوعات", "Payments")}</button>
        </div>
      </div>
      {view === "invoices" ? <InvoiceList base="/dashboard/purchases/invoices" /> : view === "aging" ? <AgingView asOf={sp.get("asOf") ?? todayRiyadh()} supplierId={sp.get("supplierId") ?? ""} go={go} /> : <PaymentsView prefill={sp.get("pay") ? { supplierId: sp.get("pay")!, invoiceId: sp.get("invoice") } : null} />}
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

/** `prefill` (Qoyod parity — the 💳 on a purchase invoice or a voucher row): open «تسجيل سداد لمورد» on that supplier,
 *  and that invoice's open amount in its allocation. The dialog, its checks and the API are unchanged. */
function PaymentsView({ prefill }: { prefill: { supplierId: string; invoiceId: string | null } | null }) {
  const { L } = useLang();
  // Qoyod parity (accountant workspace only): «سندات الموردين» — the filter card (supplier, period, status; applied to the
  // list already loaded), the same columns in Qoyod's words (المرجع … الخيارات), the dark title bar and the pager.
  const qoyod = useAccountantView();
  const t = useTerm();
  const pf = useFilters({ supplierId: "", from: "", to: "", status: "", locations: [] as string[] });
  const pa = pf.applied;
  const pays = useApi<Payment[]>(`/api/accounting/ap/payments${qoyod && pa.supplierId ? `?supplierId=${encodeURIComponent(pa.supplierId)}` : ""}`);
  const sups = useApi<Supplier[]>("/api/accounting/ap/suppliers");
  const payRows = (pays.data ?? []).filter((p) => !qoyod || ((!pa.from || p.paymentDate >= pa.from) && (!pa.to || p.paymentDate <= pa.to) && (!pa.status || p.status === pa.status) && (!pa.locations.length || pa.locations.includes(p.branchId ?? UNASSIGNED_LOCATION))));
  const { pageRows, pager } = usePaging(payRows);
  const w = useWrite();
  const [open, setOpen] = useState(!!prefill);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [reason, setReason] = useState("");
  const [f, setF] = useState({ supplierId: prefill?.supplierId ?? "", paymentDate: todayRiyadh(), method: "BANK_TRANSFER", reference: "", paidFromAccountId: "", branchId: "", alloc: {} as Record<string, string> });
  // «الموقع» (WP-B): "" = the default (the branch every allocated invoice shares, else none — the server warns), "none" = «غير محدد».
  const branches = useLocations();
  // «الحساب» (BATCH22 WP-D): the cash / bank account paid from; empty = the method's default account.
  const cash = useApi<{ accounts: { id: string; code: string; nameAr: string | null; nameEn: string; controlType: string | null }[] }>(open ? "/api/accounting/cash-accounts" : null);
  const fromAccounts = (cash.data?.accounts ?? []).filter((a) => a.controlType === "CASH" || a.controlType === "BANK");
  const inv = useApi<List>(f.supplierId ? `/api/accounting/ap/invoices?status=POSTED&supplierId=${f.supplierId}` : null);
  const openInv = (inv.data?.rows ?? []).filter((r) => Number(r.outstanding) > 0);
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !prefill?.invoiceId || !inv.data) return;
    const row = inv.data.rows.find((r) => r.id === prefill.invoiceId && Number(r.outstanding) > 0);
    setPrefilled(true);
    if (row) setF((x) => ({ ...x, alloc: { ...x.alloc, [row.id]: row.outstanding } }));
  }, [prefilled, prefill, inv.data]);
  // «نقص من المورد»: the supplier's open claims — pay what the invoice owes less what the supplier still owes back.
  const claims = useApi<{ rows: { invoice: { id: string }; openGross: string }[]; openGross: string }>(f.supplierId ? `/api/purchases/claims?supplierId=${f.supplierId}` : null);
  const claimOn = (invoiceId: string) => (claims.data?.rows ?? []).filter((c) => c.invoice.id === invoiceId).reduce((a, c) => a + Number(c.openGross), 0);
  // A5: the part paying the supplier's opening balance (no invoice in the system), capped by what it still owes.
  const [toOpening, setToOpening] = useState("");
  const openingOutstanding = Number((sups.data ?? []).find((s) => s.id === f.supplierId)?.openingOutstanding ?? 0);
  const total = Object.values(f.alloc).reduce((s, v) => s + (Number(v) || 0), 0) + (Number(toOpening) || 0);
  // Qoyod's voucher (accountant workspace): an amount spread by «تخصيص تلقائي» — on by default; the inputs stay editable.
  const [auto, setAuto] = useState(true);
  const [amount, setAmount] = useState("");
  const spread = (v: string) => {
    setAmount(v);
    if (!auto) return;
    const r = allocateOldestFirst(Number(v) || 0, openInv, openingOutstanding);
    setF((x) => ({ ...x, alloc: r.alloc }));
    setToOpening(r.toOpening);
  };
  const supplierRow = (sups.data ?? []).find((s) => s.id === f.supplierId);
  const owed = openInv.reduce((a, r) => a + Number(r.outstanding), 0) + openingOutstanding;
  const newBtn = <Btn variant="primary" onClick={() => setOpen(true)} data-testid="pay-new">+ {qoyod ? t("recordPayment") : L("تسجيل سداد", "Record a payment")}</Btn>;
  const table = (list: Payment[]) => (
    <div className="hr-tablewrap">
      <table className="hr-table is-dense" data-testid="payments" data-layout={qoyod ? "qoyod" : undefined}>
        <thead><tr><th>{qoyod ? t("colRef") : L("السداد", "Payment")}</th><th>{L("المورد", "Supplier")}</th><th className="acct-hide-m">{L("التاريخ", "Date")}</th><th className="acct-hide-m">{qoyod ? t("colMethod") : L("الطريقة", "Method")}</th><th className="acct-hide-m">{L("الفواتير", "Invoices")}</th><th className="num">{L("المبلغ", "Amount")}</th>{qoyod ? <th className="num acct-hide-m" title={L("الجزء غير المخصص لفواتير — يسدد الرصيد الافتتاحي للمورد", "The part not applied to invoices — it pays the supplier's opening balance")}>{L("المبلغ غير المخصص", "Unallocated")}</th> : null}<th>{L("الحالة", "Status")}</th><th>{qoyod ? t("colOptions") : ""}</th></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} className={p.status === "VOIDED" ? "is-muted" : undefined}>
              <td>{p.journalEntryId ? <Link className="acct-code" href={`/dashboard/accounting/journals/${p.journalEntryId}`}>{p.number}</Link> : <span className="acct-code">{p.number}</span>}</td>
              <td>{p.supplierName}</td><td className="acct-hide-m hr-num">{p.paymentDate}</td><td className="acct-hide-m">{L(METHOD[p.method]?.[0] ?? p.method, METHOD[p.method]?.[1] ?? p.method)}{p.reference ? ` · ${p.reference}` : ""}</td>
              <td className="acct-hide-m acct-code">{p.invoices.join(" ، ")}</td><td className="num hr-num">{money(p.amount)}</td>
              {qoyod ? <td className="num hr-num acct-hide-m" data-testid={`pay-unallocated-${p.number}`}>{p.allocated !== undefined ? money(Number(p.amount) - Number(p.allocated)) : "—"}{p.allocated !== undefined && Number(p.amount) - Number(p.allocated) > 0 ? <span className="hr-caption" style={{ display: "block" }}>{L("على الرصيد الافتتاحي", "to the opening balance")}</span> : null}</td> : null}
              <td>{p.status === "VOIDED" ? <span className="hr-dot tone-cancelled"><span>{L("ملغى", "Voided")}</span></span> : qoyod ? <span className="hr-dot tone-success"><span>{L("مستعمل", "Used")}</span></span> : <span className="hr-dot tone-success"><span>{L("مرحّل", "Posted")}</span></span>}</td>
              <td><span className="acct-actions">{qoyod && p.status === "POSTED" ? <Link className="hr-btn is-sm is-ghost" href={`/dashboard/accounting/ap?view=payments&pay=${encodeURIComponent(p.supplierId)}`} onClick={() => { setF((x) => ({ ...x, supplierId: p.supplierId, alloc: {} })); setOpen(true); }} aria-label={L(`سداد جديد للمورد ${p.supplierName}`, `New payment to ${p.supplierName}`)} title={L("سداد جديد لهذا المورد", "New payment to this supplier")} data-testid={`pay-again-${p.number}`}>💳</Link> : null}{p.status === "POSTED" ? <Btn size="sm" variant="ghost" onClick={() => setVoiding(p)}>{L("إلغاء", "Void")}</Btn> : null}</span></td>
            </tr>
          ))}
          {!list.length ? <tr><td colSpan={qoyod ? 9 : 8} className="acct-hint">{L("لا مدفوعات بعد.", "No payments yet.")}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
  async function record() {
    const allocations = Object.entries(f.alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount).toFixed(2) }));
    const r = await w.run<{ branchWarning?: boolean }>("pay", "/api/accounting/ap/payments", "POST", { supplierId: f.supplierId, paymentDate: f.paymentDate, method: f.method, reference: f.reference || null, ...(f.paidFromAccountId ? { paidFromAccountId: f.paidFromAccountId } : {}), ...(f.branchId ? { branchId: f.branchId === UNASSIGNED_LOCATION ? null : f.branchId } : {}), amount: total.toFixed(2), allocations }, L("سُجّل السداد ورُحّل.", "Payment recorded and posted."));
    if (r) {
      // «الموقع»: the invoices paid sit at different locations (or none) — the voucher has none («غير محدد»).
      if (r.branchWarning) w.setDone(L("سُجّل السداد ورُحّل. تنبيه: الفواتير المسددة في مواقع مختلفة أو بلا موقع، فالسند بلا موقع («غير محدد»).", "Payment recorded and posted. Note: the invoices paid sit at different locations (or none), so the voucher has no location («Unassigned»)."));
      setOpen(false); setF({ ...f, alloc: {}, reference: "" }); setToOpening(""); setAmount(""); pays.reload(); sups.reload();
    }
  }
  return (
    <>
      <Msg error={w.error ?? pays.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {qoyod ? (
        <FilterCard onApply={pf.apply} onReset={pf.reset} busy={pays.loading} testId="pay-filter">
          <div className="qc-field"><span className="qc-label">{t("colSupplier")}</span>
            <Select value={pf.draft.supplierId} onChange={(e) => pf.set("supplierId", e.target.value)} aria-label={t("colSupplier")}><option value="">{L("الكل", "All")}</option>{(sups.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></div>
          <DateRange from={pf.draft.from} to={pf.draft.to} onChange={(r) => pf.setDraft({ ...pf.draft, ...r })} />
          <div className="qc-field"><span className="qc-label">{t("colStatus")}</span>
            <Select value={pf.draft.status} onChange={(e) => pf.set("status", e.target.value)} aria-label={t("colStatus")}><option value="">{L("الكل", "All")}</option><option value="POSTED">{L("مرحّل", "Posted")}</option><option value="VOIDED">{L("ملغى", "Voided")}</option></Select></div>
          <LocationFilter value={pf.draft.locations} onChange={(v) => pf.set("locations", v)} testId="pay-locations" />
        </FilterCard>
      ) : <div className="acct-actions">{newBtn}</div>}
      {!pays.data ? <OpsLoading /> : qoyod ? (
        <Section title={t("supplierPayments")} actions={newBtn} testId="payments-section">
          <ListPageSize {...pager} />
          {table(pageRows)}
          <ListFooter {...pager} noun={L("سند", "vouchers")} emptyText={L("لا توجد أي سندات", "No vouchers")} />
        </Section>
      ) : table(pays.data)}
      <Dialog open={open} title={qoyod ? L("إنشاء سند مورد", "Create a supplier voucher") : L("تسجيل سداد لمورد", "Record a supplier payment")} onClose={() => setOpen(false)} className={qoyod ? "is-wide" : undefined}
        actions={qoyod
          ? <><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={w.busy === "pay"} disabled={!f.supplierId || total <= 0} onClick={record} data-testid="pay-confirm">{L("حفظ", "Save")} <bdi className="hr-num">· {money(total)} {L("ر.س", "SAR")}</bdi></Btn></>
          : <><Btn onClick={() => setOpen(false)}>{L("إلغاء", "Cancel")}</Btn><Btn variant="primary" busy={w.busy === "pay"} disabled={!f.supplierId || total <= 0} onClick={record} data-testid="pay-confirm">{L(`سداد ${money(total)} ر.س`, `Pay SAR ${money(total)}`)}</Btn></>}>
        {qoyod ? (
          <div className="hr-stack" data-testid="pay-voucher">
            <FormField label={L("الجهة", "Party")} required>
              <Select value={f.supplierId} onChange={(e) => { setF({ ...f, supplierId: e.target.value, alloc: {} }); setAmount(""); setToOpening(""); }} aria-label={L("الجهة", "Party")} data-testid="pay-supplier"><option value="">{L("اختر المورد", "Choose the supplier")}</option>{(sups.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            </FormField>
            {/* «الحساب» (WP-D, SupplierPayment.paidFromAccountId): the cash / bank account paid from; none chosen (or no chart
                of accounts yet) = the method's role account. */}
            {fromAccounts.length ? (
              <FormField label={L("الحساب", "Account")} help={L("فارغ = حساب طريقة الدفع (البنك أو الصندوق)", "Empty = the method's account (bank or cash)")}>
                <Select value={f.paidFromAccountId} onChange={(e) => setF({ ...f, paidFromAccountId: e.target.value })} aria-label={L("الحساب", "Account")} data-testid="pay-from-account">
                  <option value="">{L("حسب الطريقة (الافتراضي)", "By method (default)")}</option>
                  {fromAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {L(a.nameAr || a.nameEn, a.nameEn)}</option>)}
                </Select>
              </FormField>
            ) : (
              <FormField label={L("الحساب", "Account")} help={L("حسب طريقة الدفع (البنك أو الصندوق)", "Per the method (bank or cash)")}>
                <span className="qf-readonly" data-testid="pay-account-method">{L(METHOD[f.method]?.[0] ?? f.method, METHOD[f.method]?.[1] ?? f.method)}</span>
              </FormField>
            )}
            <FormField label={L("التاريخ", "Date")} required><input type="date" className="hr-input" value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} aria-label={L("التاريخ", "Date")} data-testid="pay-date" /></FormField>
            <FormField label={L("المبلغ (﷼)", "Amount (SAR)")} required help={auto ? L("يُوزَّع على الفواتير الأقدم أولًا", "Spread over the oldest invoices first") : L("وزّعه على الفواتير أدناه", "Spread it over the invoices below")}>
              <input className="hr-input acct-amount" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => spread(e.target.value.replace(/[^\d.]/g, ""))} aria-label={L("المبلغ", "Amount")} disabled={!f.supplierId} data-testid="pay-amount" />
            </FormField>
            <FormField label={L("الطريقة", "Method")}><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} aria-label={L("الطريقة", "Method")}>{Object.entries(METHOD).map(([k, [ar, en]]) => <option key={k} value={k}>{L(ar, en)}</option>)}</Select></FormField>
            <FormField label={L("المرجع", "Reference")}><input className="hr-input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} aria-label={L("المرجع", "Reference")} /></FormField>
            <FormField label={L("الموقع", "Location")} help={L("الافتراضي: موقع الفواتير المسددة إن اتفقت", "Default: the location the paid invoices share")}>
              <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} aria-label={L("الموقع", "Location")} data-testid="pay-location">
                <option value="">{L("الافتراضي", "Default")}</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr, b.nameEn)}</option>)}
                <option value={UNASSIGNED_LOCATION}>{L("غير محدد", "Unassigned")}</option>
              </Select>
            </FormField>
            <label className="pur-check" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); if (e.target.checked) { const r = allocateOldestFirst(Number(amount) || 0, openInv, openingOutstanding); setF((x) => ({ ...x, alloc: r.alloc })); setToOpening(r.toOpening); } }} data-testid="pay-auto" /> {L("تخصيص السند تلقائيًا حسب أقدمية الفواتير", "Allocate the voucher by invoice age automatically")}</label>
            {f.supplierId ? <PartyCard title={L("تفاصيل الجهة", "Party details")} empty="—" testId="pay-party" rows={[
              { k: L("الاسم", "Name"), v: supplierRow?.name ?? "—" },
              { k: L("الرقم الضريبي", "VAT number"), v: supplierRow?.vatNumber ? <bdi className="acct-code">{supplierRow.vatNumber}</bdi> : "—" },
              { k: L("الرصيد المستحق", "Amount owed"), v: <bdi className="hr-num">{money(owed)} {L("ر.س", "SAR")}</bdi>, tone: owed > 0 ? "bad" : "good", testId: "pay-party-owed" },
            ]} /> : null}
            {amount && auto && Number(amount) > owed + 0.004 ? <Notice tone="warning">{L(`المبلغ أكبر من المستحق (${money(owed)}): الزيادة لا تُخصص — خفّضه.`, `The amount is above what is owed (${money(owed)}): the excess has nowhere to go — lower it.`)}</Notice> : null}
          </div>
        ) : null}
        {!qoyod ? <div className="hr-stack">
          <label className="hr-field"><span className="hr-label">{L("المورد", "Supplier")}</span><Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value, alloc: {} })} data-testid="pay-supplier"><option value="">{L("اختر المورد", "Choose the supplier")}</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
          <div className="acct-row">
            <label className="hr-field"><span className="hr-label">{L("التاريخ", "Date")}</span><input type="date" className="hr-input" value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} /></label>
            <label className="hr-field"><span className="hr-label">{L("الطريقة", "Method")}</span><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHOD).map(([k, [ar, en]]) => <option key={k} value={k}>{L(ar, en)}</option>)}</Select></label>
            <label className="hr-field"><span className="hr-label">{L("المرجع", "Reference")}</span><input className="hr-input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
          </div>
          {fromAccounts.length ? (
            <label className="hr-field"><span className="hr-label">{L("الحساب (مدفوعة من)", "Account (paid from)")}</span>
              <Select value={f.paidFromAccountId} onChange={(e) => setF({ ...f, paidFromAccountId: e.target.value })} data-testid="pay-from-account">
                <option value="">{L("حسب الطريقة (الافتراضي)", "By method (default)")}</option>
                {fromAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {L(a.nameAr || a.nameEn, a.nameEn)}</option>)}
              </Select></label>
          ) : null}
          {branches.length ? (
            <label className="hr-field"><span className="hr-label">{L("الموقع", "Location")}</span>
              <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} data-testid="pay-location">
                <option value="">{L("الافتراضي (موقع الفواتير المسددة)", "Default (the paid invoices' location)")}</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{L(b.nameAr, b.nameEn)}</option>)}
                <option value={UNASSIGNED_LOCATION}>{L("غير محدد", "Unassigned")}</option>
              </Select></label>
          ) : null}
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
        </div> : null}
        {qoyod && f.supplierId ? (
          <div className="hr-stack" style={{ marginTop: 12 }}>
            {Number(claims.data?.openGross ?? 0) > 0 ? <Notice tone="warning"><span data-testid="pay-claim-warning">{L(`لدى هذا المورد مطالبات مفتوحة بقيمة ${money(claims.data?.openGross)} ر.س (نقص فوترَه ولم يصل). انتظر إشعاره الدائن أو اخصمها قبل سداد كامل الفاتورة.`, `This supplier has open claims of SAR ${money(claims.data?.openGross)} (billed, not delivered). Wait for its credit note or hold it back before paying the invoice in full.`)}</span></Notice> : null}
            {openInv.length ? (
              <table className="hr-table is-dense" data-testid="pay-alloc"><thead><tr><th>{L("الفاتورة", "Invoice")}</th><th className="hr-num">{L("التاريخ", "Date")}</th><th className="num">{L("المتبقي", "Open")}</th><th className="num">{L("المخصص", "Allocated")}</th></tr></thead>
                <tbody>{[...openInv].sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate)).map((r) => <tr key={r.id}><td className="acct-code">{r.number} · {r.supplierRef}{claimOn(r.id) ? <span className="hr-caption"> · {L(`مطالبة ${money(claimOn(r.id))}`, `claim ${money(claimOn(r.id))}`)}</span> : null}</td><td className="hr-num">{r.invoiceDate}</td><td className="num hr-num">{money(r.outstanding)}</td><td className="num"><input className="hr-input acct-amount" style={{ width: 110 }} inputMode="decimal" value={f.alloc[r.id] ?? ""} placeholder="0.00" onChange={(e) => { setAuto(false); setF({ ...f, alloc: { ...f.alloc, [r.id]: e.target.value } }); }} aria-label={L(`المخصص للفاتورة ${r.number}`, `Allocated to ${r.number}`)} data-testid={`pay-alloc-${r.number}`} /></td></tr>)}</tbody></table>
            ) : <p className="acct-hint">{L("لا فواتير مرحّلة مفتوحة لهذا المورد.", "No open posted invoices for this supplier.")}</p>}
            {openingOutstanding > 0 ? (
              <label className="hr-field"><span className="hr-label">{L(`من الرصيد الافتتاحي (المتبقي ${money(openingOutstanding)})`, `Against the opening balance (open ${money(openingOutstanding)})`)}</span>
                <input className="hr-input acct-amount" inputMode="decimal" value={toOpening} onChange={(e) => { setAuto(false); setToOpening(e.target.value); }} data-testid="pay-opening" /></label>
            ) : null}
            <p className="acct-hint">{L("يُرحَّل السند: مدين الذمم الدائنة / دائن البنك (أو الصندوق). الخادم يتحقق من كل تخصيص.", "The voucher posts Dr accounts payable / Cr bank (or cash). The server checks every allocation.")}</p>
          </div>
        ) : null}
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
