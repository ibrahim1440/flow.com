"use client";

// «كمّل الطلب» after a supervisor approved going over the credit limit (Abu Fahd M1 / H2). The approval notification opens
// this page: what was asked (the sale / order / held order, the customer, the amount) and one button that sends the very
// request that was refused, as the rep, with a new request key — the endpoint re-checks everything and uses the approval.
// Existing tokens only (the invoice shell's card); no new layout.
import Link from "next/link";
import { use, useState } from "react";
import { InvShell, Msg, money, useApi, useLang } from "../../invoices/_ui/inv";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useD21Title } from "@/components/shell/page-context";

type Resume = {
  id: string; kind: "ORDER" | "QUOTE_ORDER" | "DIRECT_SALE"; amount: string; status: string; expiresAt: string | null; note: string | null;
  customer: { id: string; name: string }; usedOrderId: string | null;
  resume: { path: string; body: Record<string, unknown> | null } | null;
  heldOrder: { id: string; orderNumber: number; paymentHold: string | null; status: string } | null;
  /** Gate R7: SYSTEM = closed when the held order was released; WITHDRAWN = the rep withdrew it. */
  closedBy?: "SYSTEM" | "WITHDRAWN" | null;
};

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export default function CreditResumePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L, lang } = useLang();
  // Abu Fahd R2 N6: the page is «كمّل الطلب» (not the dashboard's name).
  useD21Title(L("كمّل الطلب", "Continue the order"));
  const q = useApi<Resume>(`/api/customers/credit-overrides/${encodeURIComponent(id)}/resume`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderId: string | null; orderNumber: number | null } | null>(null);
  async function withdraw() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/customers/credit-overrides/${encodeURIComponent(id)}/withdraw`, { method: "POST" }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    if (res?.ok) { q.reload?.(); return; }
    setErr(localizeApiError(j) ?? L("ما انسحب — حاول مرة ثانية.", "Not withdrawn — try again."));
  }
  const r = q.data;
  const what = !r ? "" : r.heldOrder ? L(`الطلب #${r.heldOrder.orderNumber} الموقوف — يكمل آجل`, `Held order #${r.heldOrder.orderNumber} — continue on account`)
    : r.kind === "DIRECT_SALE" ? L("بيع مباشر", "Direct sale") : r.kind === "QUOTE_ORDER" ? L("طلب من عرض السعر", "Order from the quotation") : L("طلب جديد", "New order");
  const statusText = !r ? "" : r.status === "APPROVED" ? L("معتمد — كمّل الحين", "Approved — continue now")
    : r.status === "USED" ? L("انستخدم — الطلب انسوّى", "Used — the order was placed") : r.status === "PENDING" ? L("ينتظر المشرف", "Waiting for the supervisor")
    : r.status === "EXPIRED" ? L("انتهت مدته — اطلب اعتماد جديد", "Expired — ask for a new approval")
    : r.closedBy === "SYSTEM" ? L("انقفل تلقائيًا — الطلب انفك", "Closed automatically — the order was released")
    : r.status === "WITHDRAWN" ? L("سحبته", "You withdrew it") : L("انرفض", "Refused");

  async function go() {
    if (!r?.resume || busy) return;
    setBusy(true); setErr(null);
    const body = r.resume.body ? { ...r.resume.body, ...("requestKey" in r.resume.body ? { requestKey: newKey() } : {}) } : undefined;
    const res = await fetch(r.resume.path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": newKey() }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    if (!res?.ok) { setErr(localizeApiError(b, lang === "en" ? "en" : "ar") ?? b.error ?? L("ما كمل — جرّب مرة ثانية.", "It did not go through — try again.")); return; }
    const order = b.order ?? b;
    setDone({ orderId: typeof order?.id === "string" ? order.id : null, orderNumber: typeof order?.orderNumber === "number" ? order.orderNumber : typeof b.orderNumber === "number" ? b.orderNumber : null });
    q.reload();
  }

  return (
    <InvShell title={L("كمّل الطلب", "Continue the order")} testId="credit-resume" bare>
      <Msg error={err ?? q.error} />
      {!r ? null : (
        <div className="acct-card inv-done" data-testid="credit-resume-card" data-status={r.status}>
          <h2>{what}</h2>
          <dl className="inv-totals">
            <div><dt>{L("العميل", "Customer")}</dt><dd><bdi>{r.customer.name}</bdi></dd></div>
            <div><dt>{L("المبلغ المعتمد", "Approved amount")}</dt><dd><bdi className="hr-num">{money(r.amount)}</bdi> {L("⃁", "SAR")}</dd></div>
            <div><dt>{L("الحالة", "Status")}</dt><dd data-testid="credit-resume-status">{statusText}</dd></div>
            {r.note && !r.closedBy ? <div><dt>{L("ملاحظة المشرف", "Supervisor's note")}</dt><dd>{r.note}</dd></div> : null}
          </dl>
          {done ? <p className="acct-hint" role="status" data-testid="credit-resume-done">
            {done.orderNumber ? L(`✓ انسوّى الطلب #${done.orderNumber}`, `✓ Order #${done.orderNumber} placed`) : L("✓ كمّل الطلب", "✓ The order went through")}
            {done.orderId ? <> · <Link href={`/dashboard/orders?order=${done.orderId}`} data-testid="credit-resume-open">{L("افتحه", "Open it")}</Link></> : null}
          </p> : null}
          {/* Gate R7: «اسحب الطلب» — the rep's own waiting request (e.g. the order was released by them in the meantime). */}
          {r.status === "PENDING" ? <button type="button" className="hr-btn" disabled={busy} onClick={withdraw} data-testid="credit-resume-withdraw">{L("اسحب الطلب", "Withdraw the request")}</button> : null}
          {!r.resume && r.status === "APPROVED" ? <p className="acct-hint">{L("أرسل الطلب نفسه مرة ثانية خلال 3 أيام — الاعتماد يمشّيه مرة وحدة.", "Send the same order again within 3 days — the approval lets it through once.")}</p> : null}
          <div className="acct-actions">
            {r.resume && r.status === "APPROVED" && !done ? <button type="button" className="hr-btn is-primary" disabled={busy} onClick={go} data-testid="credit-resume-go">{busy ? L("جارٍ…", "Working…") : r.heldOrder ? L("كمّل الطلب آجل", "Continue on account") : L("كمّل الطلب", "Place the order")}</button> : null}
            {r.heldOrder ? <Link className="hr-btn" href={`/dashboard/orders?order=${r.heldOrder.id}`} data-testid="credit-resume-order">{L(`افتح الطلبات (#${r.heldOrder.orderNumber})`, `Open orders (#${r.heldOrder.orderNumber})`)}</Link> : null}
            <Link className="hr-btn" href={`/dashboard/customers/${r.customer.id}`}>{L("ملف العميل", "Customer file")}</Link>
          </div>
        </div>
      )}
    </InvShell>
  );
}
