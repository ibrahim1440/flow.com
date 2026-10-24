"use client";

// «كشف حساب العميل» and receipt application: the open invoices and debit notes (with days past due), the unapplied
// receipts and credit-note credit, the aging, and the statement of account (opening, moves, running balance,
// closing) for a period. A holder of accounting › ar applies a receipt or a credit to an open invoice (full or
// partial, many-to-many) and can undo an application with a reason; the ledger follows (POSTING-CONTRACT §4).
import Link from "next/link";
import { use, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { D21Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { DocNo, InvShell, Msg, money, useApi, useLang, useWrite, todayRiyadh } from "../../invoices/_ui/inv";

type Open = { id: string; kind: string; number: string; issueDate: string; dueDate: string | null; total: string; applied: string; open: string; daysOverdue: number };
type Credit = { id: string; kind: "RECEIPT" | "CREDIT_NOTE"; ref: string; date: string; amount: string; applied: string; unapplied: string };
type Move = { date: string; kind: string; ref: string; id: string; debit: string; credit: string; balance: string };
type App = { id: string; invoiceId: string; collectionId: string | null; creditNoteId: string | null; amount: string; appliedDate: string; atReceipt: boolean };
type Data = {
  customer: { id: string; name: string; nameAr: string | null; vatNumber: string | null; creditLimit: string | null; paymentTermsDays: number | null };
  asOf: string; open: Open[]; credits: Credit[]; aging: Record<string, string | number>;
  statement: { opening: string; closing: string; totalDebit: string; totalCredit: string; rows: Move[] };
  applications: App[]; can: { ar: boolean };
};
const MOVE: Record<string, [string, string]> = { INVOICE: ["فاتورة", "Invoice"], DEBIT_NOTE: ["إشعار مدين", "Debit note"], CREDIT_NOTE: ["إشعار دائن", "Credit note"], RECEIPT: ["تحصيل", "Receipt"], RECEIPT_REVERSED: ["عكس تحصيل", "Receipt reversed"] };

export default function StatementPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = use(params);
  const { L, lang } = useLang();
  const [from, setFrom] = useState(`${todayRiyadh().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayRiyadh());
  const r = useApi<Data>(`/api/accounting/ar/customers/${customerId}?from=${from}&to=${to}`);
  const w = useWrite();
  const [apply, setApply] = useState<{ source: Credit; invoiceId: string; amount: string } | null>(null);
  const [undo, setUndo] = useState<{ app: App; reason: string } | null>(null);
  const d = r.data;
  const docNo = (id: string) => d?.open.find((o) => o.id === id)?.number ?? d?.statement.rows.find((m) => m.id === id)?.ref ?? id.slice(-6);
  const doApply = async () => {
    if (!apply) return;
    const body = { invoiceId: apply.invoiceId, amount: apply.amount, ...(apply.source.kind === "RECEIPT" ? { collectionId: apply.source.id } : { creditNoteId: apply.source.id }) };
    const ok = await w.run("apply", "/api/accounting/ar/applications", "POST", body, L("خُصِّص المبلغ.", "Applied."));
    setApply(null);
    if (ok) r.reload();
  };
  const doUndo = async () => {
    if (!undo) return;
    const ok = await w.run("undo", `/api/accounting/ar/applications/${undo.app.id}/reverse`, "POST", { reason: undo.reason }, L("أُلغي التخصيص.", "Application reversed."));
    setUndo(null);
    if (ok) r.reload();
  };
  return (
    <InvShell title={d ? `${L("كشف حساب", "Statement")} · ${d.customer.nameAr || d.customer.name}` : L("كشف حساب العميل", "Customer statement")} testId="ar-statement"
      meta={d ? <span className="acct-meta">{d.customer.vatNumber ? <><span>{L("الرقم الضريبي", "VAT")} <bdi className="acct-code">{d.customer.vatNumber}</bdi></span><span aria-hidden="true">·</span></> : null}<span>{L("حد الائتمان", "Credit limit")} {d.customer.creditLimit ? money(d.customer.creditLimit) : L("غير محدد", "not set")}</span><span aria-hidden="true">·</span><span>{L("مدة السداد", "Terms")} {d.customer.paymentTermsDays ?? "—"}</span></span> : undefined}
      actions={<Link className="hr-btn" href={`/dashboard/sales/invoices?customerId=${customerId}`}>{L("فواتير العميل", "Customer invoices")}</Link>}>
      <Msg error={w.error ?? r.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!d ? <OpsLoading /> : (
        <>
          <div className="acct-cards">
            <div className="acct-card"><span className="acct-hint">{L("الرصيد", "Balance")}</span><b className="hr-num" data-testid="st-balance">{money(String(d.aging.balance))}</b></div>
            <div className="acct-card"><span className="acct-hint">{L("المتأخر", "Overdue")}</span><b className="hr-num inv-late">{money(String(d.aging.overdue))}</b>{Number(d.aging.oldestOverdueDays) > 0 ? <span className="acct-hint">{L(`أقدم تأخير ${d.aging.oldestOverdueDays} يومًا`, `oldest ${d.aging.oldestOverdueDays} days`)}</span> : null}</div>
            <div className="acct-card"><span className="acct-hint">{L("أرصدة دائنة غير مخصصة", "Unapplied credit")}</span><b className="hr-num">{money(String(d.aging.unappliedCredit))}</b></div>
          </div>

          <div className="acct-card">
            <h2>{L("الفواتير المفتوحة", "Open invoices")}</h2>
            {d.open.length === 0 ? <p className="acct-hint">{L("لا فواتير مفتوحة.", "No open invoices.")}</p> : (
              <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="open-items">
                <thead><tr><th>{L("المستند", "Document")}</th><th>{L("الإصدار", "Issued")}</th><th>{L("الاستحقاق", "Due")}</th><th className="num">{L("الإجمالي", "Total")}</th><th className="num">{L("المسدَّد", "Paid")}</th><th className="num">{L("المتبقي", "Open")}</th></tr></thead>
                <tbody>{d.open.map((o) => (
                  <tr key={o.id}><td><Link href={`/dashboard/sales/invoices/${o.id}`}><DocNo n={o.number} /></Link></td><td className="hr-num">{o.issueDate}</td>
                    <td className="hr-num">{o.dueDate ?? "—"}{o.daysOverdue > 0 ? <span className="inv-sub inv-late">{L(`متأخرة ${o.daysOverdue} يومًا`, `${o.daysOverdue} days overdue`)}</span> : null}</td>
                    <td className="num hr-num">{money(o.total)}</td><td className="num hr-num">{money(o.applied, true) || "—"}</td><td className="num hr-num"><b>{money(o.open)}</b></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>

          <div className="acct-card">
            <h2>{L("تحصيلات وأرصدة دائنة غير مخصصة", "Unapplied receipts and credits")}</h2>
            {d.credits.length === 0 ? <p className="acct-hint">{L("لا شيء غير مخصص.", "Nothing unapplied.")}</p> : (
              <ul className="ops-list" data-testid="credits">{d.credits.map((c) => (
                <li key={c.id}><span>{c.kind === "RECEIPT" ? L("تحصيل", "Receipt") : L("إشعار دائن", "Credit note")} <bdi className="acct-code">{c.ref}</bdi> · <span className="hr-num">{c.date}</span></span>
                  <span className="acct-actions"><span className="hr-num">{money(c.unapplied)} / {money(c.amount)}</span>
                    {d.can.ar && d.open.length ? <button type="button" className="hr-btn is-sm is-primary" onClick={() => setApply({ source: c, invoiceId: d.open[0].id, amount: String(Math.min(Number(c.unapplied), Number(d.open[0].open)).toFixed(2)) })} data-testid={`apply-${c.id}`}>{L("تخصيص على فاتورة", "Apply to an invoice")}</button> : null}</span></li>
              ))}</ul>
            )}
            {!d.can.ar ? <p className="acct-hint">{L("التخصيص يحتاج صلاحية «الذمم المدينة» في المحاسبة.", "Applying needs the accounting › receivables duty.")}</p> : null}
          </div>

          {d.can.ar && d.applications.length ? (
            <div className="acct-card">
              <h3>{L("التخصيصات القائمة", "Applications in force")}</h3>
              <ul className="ops-list" data-testid="applications">{d.applications.map((a) => (
                <li key={a.id}><span>{a.collectionId ? L("تحصيل", "Receipt") : L("إشعار دائن", "Credit note")} → <bdi className="acct-code">{docNo(a.invoiceId)}</bdi> · <span className="hr-num">{a.appliedDate}</span>{a.atReceipt ? L(" · عند الاعتماد", " · at approval") : ""}</span>
                  <span className="acct-actions"><span className="hr-num">{money(a.amount)}</span><button type="button" className="hr-btn is-ghost is-sm" onClick={() => setUndo({ app: a, reason: "" })} data-testid={`undo-${a.id}`}>{L("إلغاء التخصيص", "Unapply")}</button></span></li>
              ))}</ul>
            </div>
          ) : null}

          <div className="acct-card">
            <h2>{L("كشف الحساب", "Statement of account")}</h2>
            <div className="acct-row">
              <label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
            <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="statement">
              <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("البيان", "Item")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
              <tbody>
                <tr className="is-muted"><td className="hr-num">{from}</td><td>{L("الرصيد الافتتاحي", "Opening balance")}</td><td /><td /><td className="num hr-num">{money(d.statement.opening)}</td></tr>
                {d.statement.rows.map((m, i) => (
                  <tr key={`${m.id}${i}`}><td className="hr-num">{m.date}</td><td>{L(MOVE[m.kind]?.[0] ?? m.kind, MOVE[m.kind]?.[1] ?? m.kind)} <bdi className="acct-code">{m.ref}</bdi></td>
                    <td className="num hr-num">{money(m.debit, true)}</td><td className="num hr-num">{money(m.credit, true)}</td><td className="num hr-num">{money(m.balance)}</td></tr>
                ))}
                <tr className="is-total"><td /><td>{L("الرصيد الختامي", "Closing balance")}</td><td className="num hr-num">{money(d.statement.totalDebit)}</td><td className="num hr-num">{money(d.statement.totalCredit)}</td><td className="num hr-num" data-testid="st-closing">{money(d.statement.closing)}</td></tr>
              </tbody>
            </table></div>
          </div>
        </>
      )}
      {apply && d ? (
        <D21Dialog lang={lang === "en" ? "en" : "ar"} title={L("تخصيص على فاتورة", "Apply to an invoice")} onClose={() => setApply(null)} testId="apply-dialog"
          actions={<><button type="button" className="hr-btn is-primary" disabled={!!w.busy} onClick={doApply} data-testid="confirm-apply">{L("تخصيص", "Apply")}</button><button type="button" className="hr-btn" onClick={() => setApply(null)}>{L("رجوع", "Back")}</button></>}>
          <p className="acct-hint">{apply.source.kind === "RECEIPT" ? L("تحصيل", "Receipt") : L("إشعار دائن", "Credit note")} <bdi className="acct-code">{apply.source.ref}</bdi> · {L("غير مخصص", "unapplied")} {money(apply.source.unapplied)}</p>
          <label className="hr-field"><span className="hr-label">{L("الفاتورة", "Invoice")}</span>
            <Select value={apply.invoiceId} onChange={(e) => setApply({ ...apply, invoiceId: e.target.value })}>
              {d.open.map((o) => <option key={o.id} value={o.id}>{`${o.number} · ${money(o.open)}`}</option>)}
            </Select></label>
          <label className="hr-field"><span className="hr-label">{L("المبلغ", "Amount")}</span><input className="hr-input acct-amount" inputMode="decimal" value={apply.amount} onChange={(e) => setApply({ ...apply, amount: e.target.value })} data-testid="apply-amount" /></label>
        </D21Dialog>
      ) : null}
      {undo ? (
        <D21Dialog lang={lang === "en" ? "en" : "ar"} title={L("إلغاء التخصيص", "Unapply")} onClose={() => setUndo(null)} testId="undo-dialog"
          actions={<><button type="button" className="hr-btn is-danger" disabled={undo.reason.trim().length < 3} onClick={doUndo} data-testid="confirm-undo">{L("إلغاء التخصيص", "Unapply")}</button><button type="button" className="hr-btn" onClick={() => setUndo(null)}>{L("رجوع", "Back")}</button></>}>
          <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}</span><input className="hr-input" value={undo.reason} onChange={(e) => setUndo({ ...undo, reason: e.target.value })} /></label>
        </D21Dialog>
      ) : null}
    </InvShell>
  );
}
