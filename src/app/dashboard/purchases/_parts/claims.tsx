"use client";
// «نقص من المورد» (feat/supplier-shortfall, 20261119090000_supplier_shortfall) — the screens of the supplier claims:
//   InvoiceClaims    on a purchase invoice: the timeline (invoice → receipt → claim → credit note / replacement /
//                    abandonment), each claim with what is open and its actions, the credit notes (cancel);
//   ClaimsTab        «مطالبات الموردين» on the purchases screen: every open claim per supplier, oldest first, its age and
//                    the > 60 days flag, the same actions;
//   ReliabilityBlock «موثوقية المورد» on the suppliers tab: fill rate, shortage value, claimed and recovered per period;
//   ClaimDialog      the credit note form, the replacement goods form, the abandonment (reason, the VAT note) and the
//                    credit note cancel. Each action's gate is the route's (the buttons only follow `can`).
import Link from "next/link";
import { useState } from "react";
import { Btn, FilterChip, Notice, OpsLoading } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { money, todayRiyadh, useApi, useLang, useWrite } from "../../accounting/_ui/shell";
import { lineVatText, plainNumber, sumAmounts } from "@/lib/purchases/amounts";

export type ClaimSettlement = { id: string; kind: "CREDIT_NOTE" | "REPLACEMENT" | "ABANDON" | "REFUND"; method?: string | null; qty: string | null; net: string; vat: string; reverseVat: boolean; reason: string | null; purchaseRecordId: string | null; createdAt: string; voidedAt: string | null; creditNote: { id: string; number: string; supplierRef: string; noteDate: string; status: string; advanceAmount?: string | null } | null };
export type Claim = {
  id: string; status: "OPEN" | "SETTLED" | "VOID"; supplierId: string; supplierName: string; stockKind: string;
  invoice: { id: string; number: string; supplierRef: string; invoiceDate: string; status: string; outstanding?: string };
  line: { lineNo: number; description: string; received: string | null; billed: string | null };
  qty: string; unitCost: string; net: string; vatRate: string; vat: string; settledQty: string; settledNet: string;
  openQty: string; openNet: string; openVat: string; openGross: string; createdAt: string; ageDays: number; stale: boolean; settlements: ClaimSettlement[];
};
export type CreditNoteRow = { id: string; number: string; supplierRef: string; noteDate: string; net: string; vat: string; gross: string; advanceAmount?: string; status: string; claimId: string; cancelReason: string | null };
type Can = { ap?: boolean; receive?: boolean; adjust?: boolean };
type Settings = { tolerancePercent: number; abandonReverseVat: boolean };
type Action = { kind: "credit" | "replace" | "abandon" | "refund"; claim: Claim } | { kind: "cancelNote"; note: CreditNoteRow };

export const CLAIM_STATUS: Record<string, [string, string, string]> = {
  OPEN: ["مفتوحة", "Open", "warning"], SETTLED: ["مسوّاة", "Settled", "success"], VOID: ["ملغاة", "Void", "cancelled"],
};
const KIND: Record<string, [string, string]> = { CREDIT_NOTE: ["إشعار دائن", "Credit note"], REPLACEMENT: ["بضاعة بديلة", "Replacement goods"], ABANDON: ["تنازل", "Abandoned"], REFUND: ["استرداد من المورد", "Refund received"] };

/** The credit note, replacement, abandonment and credit-note-cancel forms. */
export function ClaimDialog({ action, settings, onClose, onDone }: { action: Action; settings: Settings | null; onClose: () => void; onDone: (msg: string) => void }) {
  const { L } = useLang();
  const w = useWrite();
  const c = action.kind === "cancelNote" ? null : action.claim;
  const [ref, setRef] = useState("");
  const [day, setDay] = useState(todayRiyadh());
  const [net, setNet] = useState(c?.openNet ?? "");
  const [qty, setQty] = useState(c?.openQty ?? "");
  const [reason, setReason] = useState("");
  const [vatIn, setVatIn] = useState("");
  const [amount, setAmount] = useState(c?.openGross ?? "");
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [bankRef, setBankRef] = useState("");
  const netN = plainNumber(net);
  const all = !!c && netN === c.openNet;
  const computedVat = !c ? "0.00" : all ? c.openVat : (() => { const v = lineVatText(netN || "0", Number(c.vatRate)); return Number(v) > Number(c.openVat) ? c.openVat : v; })();
  // Council F6: the VAT on the supplier's document may be entered, within ±0.01 of the computed one.
  const vat = plainNumber(vatIn) !== "" ? plainNumber(vatIn) : computedVat;
  const vatOk = Math.abs(Number(vat) - Number(computedVat)) <= 0.0100001 && Number(vat) <= Number(c?.openVat ?? 0) + 1e-9;
  const grossNow = sumAmounts([netN || "0", vat]);
  // Council F4: what the invoice no longer owes (it was paid) becomes a supplier advance.
  const advance = c?.invoice.outstanding !== undefined ? Math.max(0, Number(grossNow) - Number(c.invoice.outstanding)) : 0;
  const reverse = !!settings?.abandonReverseVat && !!c && Number(c.openVat) > 0;
  async function go() {
    if (action.kind === "credit" && c) {
      const r = await w.run("cn", `/api/purchases/claims/${c.id}/credit-note`, "POST", { supplierRef: ref.trim(), noteDate: day, net: netN, ...(plainNumber(vatIn) !== "" ? { vat: plainNumber(vatIn) } : {}) });
      if (r) onDone(L("سُجّل الإشعار الدائن وخُفّض المتبقي على الفاتورة.", "The credit note is recorded and the invoice's remaining amount reduced."));
    } else if (action.kind === "replace" && c) {
      const r = await w.run("rp", `/api/purchases/claims/${c.id}/replace`, "POST", { quantity: plainNumber(qty), receivedDate: day });
      if (r) onDone(L("استُلمت البضاعة البديلة في المخزون وسُوّيت المطالبة بقدرها.", "The replacement goods are in stock and the claim settled by them."));
    } else if (action.kind === "refund" && c) {
      const r = await w.run("rf", `/api/purchases/claims/${c.id}/refund`, "POST", { amount: plainNumber(amount), method, reference: bankRef.trim() || null, receivedDate: day });
      if (r) onDone(L("سُجّل الاسترداد من المورد وسُوّيت المطالبة بقدره.", "The supplier's refund is recorded and the claim settled by it."));
    } else if (action.kind === "abandon" && c) {
      const r = await w.run("ab", `/api/purchases/claims/${c.id}/abandon`, "POST", { reason: reason.trim() });
      if (r) onDone(L("سُجّل التنازل عن المطالبة كخسارة نقص مشتريات.", "The claim is abandoned as a purchase shortage loss."));
    } else if (action.kind === "cancelNote") {
      const r = await w.run("cc", `/api/purchases/credit-notes/${action.note.id}/cancel`, "POST", { reason: reason.trim() });
      if (r) onDone(L("أُلغي الإشعار الدائن وعادت المطالبة مفتوحة.", "The credit note is cancelled and the claim open again."));
    }
  }
  const title = action.kind === "credit" ? L("إشعار دائن من المورد", "Supplier credit note") : action.kind === "replace" ? L("استلام بضاعة بديلة", "Receive replacement goods")
    : action.kind === "abandon" ? L("التنازل عن المطالبة", "Abandon the claim") : action.kind === "refund" ? L("استرداد من المورد", "Refund received from the supplier") : L("إلغاء الإشعار الدائن", "Cancel the credit note");
  const ok = action.kind === "credit" ? !!ref.trim() && Number(netN) > 0 && Number(netN) <= Number(c?.openNet ?? 0) && vatOk
    : action.kind === "refund" ? Number(plainNumber(amount)) > 0 && Number(plainNumber(amount)) <= Number(c?.openGross ?? 0)
    : action.kind === "replace" ? Number(plainNumber(qty)) > 0 && Number(plainNumber(qty)) <= Number(c?.openQty ?? 0)
    : reason.trim().length >= 3;
  return (
    <Dialog open title={title} onClose={onClose} testId="claim-dialog"
      sub={c ? <><span className="acct-code">{c.invoice.number}</span> · {L(`السطر ${c.line.lineNo}`, `line ${c.line.lineNo}`)} · {c.line.description}</> : <span className="acct-code">{action.kind === "cancelNote" ? action.note.number : ""}</span>}
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant={action.kind === "abandon" || action.kind === "cancelNote" ? "danger" : "primary"} busy={!!w.busy} disabled={!ok || !!w.busy} onClick={go} data-testid="claim-confirm">{L("تأكيد", "Confirm")}</Btn></>}>
      {w.error ? <Notice tone="danger">{w.error}</Notice> : null}
      {c ? <p className="acct-hint" data-testid="claim-open">{L("المفتوح", "Open")}: <span className="hr-num">{c.openQty}</span> · {L("صافي", "net")} <span className="hr-num">{money(c.openNet)}</span> · {L("ضريبة", "VAT")} <span className="hr-num">{money(c.openVat)}</span></p> : null}
      {action.kind === "credit" && c ? <div className="hr-form">
        <label className="hr-field"><span className="hr-label">{L("رقم الإشعار لدى المورد", "Supplier's credit note no.")} *</span><input className="hr-input" dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="cn-ref" placeholder="CN-2026-0091" /></label>
        <label className="hr-field"><span className="hr-label">{L("تاريخ الإشعار", "Credit note date")}</span><input type="date" className="hr-input" value={day} max={todayRiyadh()} min={c.invoice.invoiceDate} onChange={(e) => setDay(e.target.value)} data-testid="cn-date" /></label>
        <label className="hr-field"><span className="hr-label">{L("المبلغ قبل الضريبة", "Amount before VAT")}</span><input className="hr-input acct-amount" inputMode="decimal" value={net} onChange={(e) => setNet(e.target.value)} data-testid="cn-net" /></label>
        <label className="hr-field"><span className="hr-label">{L("الضريبة في إشعار المورد (اختياري)", "VAT on the supplier's note (optional)")}</span><input className="hr-input acct-amount" inputMode="decimal" value={vatIn} placeholder={computedVat} onChange={(e) => setVatIn(e.target.value)} data-testid="cn-vat" />{!vatOk ? <span className="acct-bad hr-caption" data-testid="cn-vat-bad">{L(`المحسوبة ${computedVat} — يُقبل فرق 0.01 فقط`, `Computed ${computedVat} — only a 0.01 difference is accepted`)}</span> : null}</label>
        <div className="hr-field"><span className="hr-label">{L("الضريبة والإجمالي", "VAT and total")}</span><span className="hr-num" data-testid="cn-gross">{money(vat)} · {money(grossNow)}</span></div>
        {advance > 0 ? <div style={{ gridColumn: "1 / -1" }}><Notice tone="info"><span data-testid="cn-advance">{L(`الفاتورة مسدَّدة: ${money(advance)} ر.س من الإشعار تُسجَّل دفعة مقدمة للمورد (مدين دفعات مقدمة للموردين) تُطبَّق لاحقًا، أو سجّل استردادًا.`, `The invoice is paid: SAR ${money(advance)} of the note is recorded as an advance to the supplier (Dr supplier advances), applied later — or record a refund.`)}</span></Notice></div> : null}
        <p className="acct-hint" style={{ gridColumn: "1 / -1" }}>{L("القيد: مدين الذمم الدائنة بالإجمالي، دائن مطالبات الموردين بالصافي، دائن ضريبة المدخلات بالضريبة. يظهر في إقرار الضريبة تعديلًا سالبًا في خانة المشتريات.", "Entry: Dr accounts payable (total), Cr supplier claims (net), Cr VAT input (VAT). The VAT return shows it as a negative adjustment of the purchases box.")}</p>
      </div> : null}
      {action.kind === "replace" && c ? <div className="hr-form">
        <label className="hr-field"><span className="hr-label">{L("الكمية المستلمة", "Quantity received")}</span><input className="hr-input acct-amount" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="rp-qty" /></label>
        <label className="hr-field"><span className="hr-label">{L("تاريخ الاستلام", "Received on")}</span><input type="date" className="hr-input" value={day} max={todayRiyadh()} onChange={(e) => setDay(e.target.value)} data-testid="rp-date" /></label>
        <p className="acct-hint" style={{ gridColumn: "1 / -1" }}>{L("تدخل المخزون بتكلفة وحدة المطالبة، بلا ضريبة (الضريبة على الفاتورة الأصلية). القيد: مدين المخزون، دائن مطالبات الموردين.", "Received into stock at the claim's unit cost, no VAT (the VAT was on the original invoice). Entry: Dr inventory, Cr supplier claims.")}</p>
      </div> : null}
      {action.kind === "refund" && c ? <div className="hr-form">
        <label className="hr-field"><span className="hr-label">{L("المبلغ المسترد (شامل الضريبة)", "Amount received (VAT incl.)")}</span><input className="hr-input acct-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="rf-amount" /></label>
        <label className="hr-field"><span className="hr-label">{L("الطريقة", "Method")}</span>
          <Select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="rf-method" aria-label={L("الطريقة", "Method")}><option value="BANK_TRANSFER">{L("تحويل بنكي", "Bank transfer")}</option><option value="CASH">{L("نقدًا", "Cash")}</option></Select>
        </label>
        <label className="hr-field"><span className="hr-label">{L("المرجع", "Reference")}</span><input className="hr-input" dir="ltr" value={bankRef} onChange={(e) => setBankRef(e.target.value)} data-testid="rf-ref" /></label>
        <label className="hr-field"><span className="hr-label">{L("تاريخ الاستلام", "Received on")}</span><input type="date" className="hr-input" value={day} max={todayRiyadh()} onChange={(e) => setDay(e.target.value)} data-testid="rf-date" /></label>
        <p className="acct-hint" style={{ gridColumn: "1 / -1" }}>{L("القيد: مدين البنك (أو الصندوق)، دائن مطالبات الموردين بالصافي، ودائن ضريبة المدخلات بحصة الضريبة المستردة.", "Entry: Dr bank (or cash), Cr supplier claims (net), Cr VAT input (the VAT share returned).")}</p>
      </div> : null}
      {action.kind === "abandon" && c ? <>
        <p>{reverse
          ? L(`يُسجَّل المفتوح (${money(c.openNet)} + ضريبة ${money(c.openVat)}) خسارة نقص مشتريات، وتُعكس ضريبة المدخلات عليه.`, `What is open (${money(c.openNet)} + VAT ${money(c.openVat)}) becomes a purchase shortage loss, and its input VAT is reversed.`)
          : L(`يُسجَّل المفتوح (${money(c.openNet)}) خسارة نقص مشتريات؛ تبقى ضريبة المدخلات كما هي.`, `What is open (${money(c.openNet)}) becomes a purchase shortage loss; the input VAT stays as it is.`)}</p>
        <Notice tone="warning"><span data-testid="abandon-vat-note">{L("عكس ضريبة المدخلات عند التنازل إعداد في «الإعدادات › المخزون» (مفعّل افتراضيًا). تحقق مع مستشارك الضريبي.", "Reversing the input VAT on an abandonment is a setting in «Settings › Inventory» (on by default). Check with your tax adviser.")}</span></Notice>
        <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")} *</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="claim-reason" placeholder={L("مثال: المورد رفض التعويض بعد المراجعة", "e.g. the supplier declined after review")} /></label>
        <p className="acct-hint">{L("يحتاج صلاحية «المخزون › تسوية» وتأكيد الهوية.", "Needs Inventory › Adjust and a fresh confirmation.")}</p>
      </> : null}
      {action.kind === "cancelNote" ? <>
        <p>{L("يُعكس قيد الإشعار وتعود المطالبة مفتوحة والمتبقي على الفاتورة كما كان.", "The note's entry is reversed; the claim is open again and the invoice's remaining amount back as it was.")}</p>
        <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")} *</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="claim-reason" /></label>
      </> : null}
    </Dialog>
  );
}

function ClaimActions({ c, can, onAct }: { c: Claim; can: Can; onAct: (a: Action) => void }) {
  const { L } = useLang();
  if (c.status !== "OPEN" || c.invoice.status !== "POSTED") return null;
  return (
    <span className="pur-actions">
      {can.ap ? <Btn size="sm" onClick={() => onAct({ kind: "credit", claim: c })} data-testid={`claim-credit-${c.id}`}>{L("إشعار دائن", "Credit note")}</Btn> : null}
      {can.receive ? <Btn size="sm" variant="ghost" onClick={() => onAct({ kind: "replace", claim: c })} data-testid={`claim-replace-${c.id}`}>{L("بضاعة بديلة", "Replacement")}</Btn> : null}
      {can.ap ? <Btn size="sm" variant="ghost" onClick={() => onAct({ kind: "refund", claim: c })} data-testid={`claim-refund-${c.id}`}>{L("استرداد", "Refund")}</Btn> : null}
      {can.adjust ? <Btn size="sm" variant="ghost" onClick={() => onAct({ kind: "abandon", claim: c })} data-testid={`claim-abandon-${c.id}`}>{L("تنازل", "Abandon")}</Btn> : null}
    </span>
  );
}

/** The claims of one purchase invoice, with its timeline. */
export function InvoiceClaims({ invoice, claims, creditNotes, can, settings, onChanged }: {
  invoice: { number: string; invoiceDate: string; receivedDate: string | null; lines: { billedQty?: string | null; quantity: string | null; shortfallTreatment?: string | null; shortfallQty?: string | null }[] };
  claims: Claim[]; creditNotes: CreditNoteRow[]; can: Can; settings: Settings | null; onChanged: (msg: string) => void;
}) {
  const { L } = useLang();
  const [act, setAct] = useState<Action | null>(null);
  const short = invoice.lines.filter((l) => l.billedQty);
  if (!short.length && !claims.length) return null;
  const sum = (xs: (string | null | undefined)[]) => xs.reduce((a, x) => a + Number(x ?? 0), 0);
  const billed = sum(short.map((l) => l.billedQty)), received = sum(short.map((l) => l.quantity));
  const settled = claims.flatMap((c) => c.settlements.filter((s) => !s.voidedAt));
  return (
    <section aria-labelledby="pi-claims-h" data-testid="pi-claims">
      <h2 className="pi-h2" id="pi-claims-h">{L("نقص من المورد", "Supplier shortfall")} <span className="acct-hint">{L("المستلم أقل من الفاتورة", "Received less than billed")}</span></h2>
      <ol className="pi-timeline" data-testid="pi-timeline">
        <li><span className="pi-tl-k">{L("الفاتورة", "Invoice")}</span><span className="hr-num">{billed}</span><span className="hr-caption"><bdi className="acct-code">{invoice.number}</bdi> · {invoice.invoiceDate}</span></li>
        <li><span className="pi-tl-k">{L("الاستلام", "Received")}</span><span className="hr-num">{received}</span><span className="hr-caption">{invoice.receivedDate ?? "—"}</span></li>
        <li className={claims.some((c) => c.status === "OPEN") ? "is-open" : ""}><span className="pi-tl-k">{L("المطالبة", "Claim")}</span><span className="hr-num">{sum(claims.map((c) => c.qty)) || sum(short.map((l) => l.shortfallQty))}</span><span className="hr-caption">{claims.length ? claims.map((c) => L(CLAIM_STATUS[c.status][0], CLAIM_STATUS[c.status][1])).join(" · ") : short.every((l) => l.shortfallTreatment === "ABSORBED") ? L("ضمن حد التسامح", "Within tolerance") : short.some((l) => l.shortfallTreatment === "LOSS") ? L("خسارة", "Loss") : L("تُفتح عند الاعتماد", "Opens on approval")}</span></li>
        {settled.map((s) => <li key={s.id} className="is-done"><span className="pi-tl-k">{L(KIND[s.kind][0], KIND[s.kind][1])}</span><span className="hr-num">{s.qty ?? money(s.net)}</span><span className="hr-caption">{s.creditNote ? <bdi className="acct-code">{s.creditNote.number}</bdi> : s.createdAt.slice(0, 10)}</span></li>)}
      </ol>
      {claims.length ? <div className="hr-tablewrap"><table className="hr-table is-dense" aria-label={L("مطالبات المورد", "Supplier claims")} data-testid="pi-claims-table">
        <thead><tr><th>{L("السطر", "Line")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("المفتوح", "Open")}</th><th className="num">{L("صافي + ضريبة مفتوح", "Open net + VAT")}</th><th>{L("الحالة", "Status")}</th><th /></tr></thead>
        <tbody>{claims.map((c) => <tr key={c.id} data-testid={`pi-claim-${c.id}`}>
          <td><bdi>{c.line.lineNo}</bdi> · {c.line.description}</td><td className="num hr-num">{c.qty}</td><td className="num hr-num">{c.openQty}</td><td className="num hr-num">{money(c.openGross)}</td>
          <td><span className={`hr-dot tone-${CLAIM_STATUS[c.status][2]}`}><span>{L(CLAIM_STATUS[c.status][0], CLAIM_STATUS[c.status][1])}</span></span>{c.stale ? <span className="pur-tag is-warn">{L(`${c.ageDays} يومًا`, `${c.ageDays} days`)}</span> : null}</td>
          <td><ClaimActions c={c} can={can} onAct={setAct} /></td>
        </tr>)}</tbody>
      </table></div> : null}
      {creditNotes.length ? <ul className="pi-notes-list" data-testid="pi-credit-notes">{creditNotes.map((n) => <li key={n.id}>
        <span><bdi className="acct-code">{n.number}</bdi> · <bdi dir="ltr">{n.supplierRef}</bdi> · {n.noteDate} · <span className="hr-num">{money(n.gross)}</span>{Number(n.advanceAmount ?? 0) ? <span className="pur-tag is-warn" data-testid={`cn-advance-${n.id}`}>{L(`دفعة مقدمة ${money(n.advanceAmount)}`, `advance ${money(n.advanceAmount)}`)}</span> : null}{n.status === "CANCELLED" ? <span className="pur-tag is-muted">{L("ملغى", "Cancelled")}</span> : null}</span>
        {n.status === "POSTED" && can.ap ? <Btn size="sm" variant="ghost" onClick={() => setAct({ kind: "cancelNote", note: n })} data-testid={`cn-cancel-${n.id}`}>{L("إلغاء", "Cancel")}</Btn> : null}
      </li>)}</ul> : null}
      {act ? <ClaimDialog action={act} settings={settings} onClose={() => setAct(null)} onDone={(m) => { setAct(null); onChanged(m); }} /> : null}
    </section>
  );
}

/** «مطالبات الموردين» — the purchases screen's claims tab. */
export function ClaimsTab({ suppliers, initialSupplier }: { suppliers: { id: string; name: string }[]; initialSupplier?: string }) {
  const { L } = useLang();
  const [supplierId, setSupplierId] = useState(initialSupplier ?? "");
  const [status, setStatus] = useState("");
  const [act, setAct] = useState<Action | null>(null);
  const [done, setDone] = useState("");
  const params = new URLSearchParams({ ...(supplierId ? { supplierId } : {}), ...(status ? { status } : {}) }).toString();
  const list = useApi<{ rows: Claim[]; suppliers: { supplierId: string; name: string; count: number; openGross: string; stale: number; oldestDays: number }[]; openGross: string; staleDays: number; settings: Settings; can: Can }>(`/api/purchases/claims${params ? `?${params}` : ""}`);
  if (list.error && !list.data) return <Notice tone="danger">{list.error}</Notice>;
  if (!list.data) return <OpsLoading />;
  const d = list.data;
  const stale = d.rows.filter((r) => r.stale).length;
  return (
    <div className="hr-stack pur-tab" data-testid="claims-tab">
      {done ? <Notice tone="success">{done}</Notice> : null}
      <div className="pur-tabhead"><p className="hr-caption">{L("ما فوترَه المورد ولم يصل: مطالبة مفتوحة حتى يصل إشعار دائن أو بضاعة بديلة أو يُتنازل عنها.", "What a supplier billed and did not deliver: an open claim until a credit note or replacement goods arrive, or it is abandoned.")}</p></div>
      <div className="acct-metrics">
        <div className="acct-metric"><span className="k">{L("مطالبات مفتوحة", "Open claims")}</span><span className="v" data-testid="claims-open-total">{money(d.openGross)}</span><span className="s">{L(`${d.rows.filter((r) => r.status === "OPEN").length} مطالبة · شامل الضريبة`, `${d.rows.filter((r) => r.status === "OPEN").length} claims · VAT inclusive`)}</span></div>
        <div className="acct-metric"><span className="k">{L(`أقدم من ${d.staleDays} يومًا`, `Older than ${d.staleDays} days`)}</span><span className="v">{stale}</span><span className="s">{stale ? <span className="acct-bad">{L("تابعها مع المورد أو قرّر", "Chase them or decide")}</span> : L("لا مطالبات متأخرة", "None overdue")}</span></div>
      </div>
      <div className="stk-tool">
        <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label={L("المورد", "Supplier")} data-testid="claims-supplier">
          <option value="">{L("كل الموردين", "All suppliers")}</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <FilterChip label={L("الحالة", "Status")} value={status} onChange={setStatus} allLabel={L("المفتوحة", "Open")}
          options={[{ value: "SETTLED", label: L("مسوّاة", "Settled") }, { value: "ALL", label: L("الكل", "All") }]} />
      </div>
      {d.suppliers.length > 1 && !supplierId ? <div className="hr-tablewrap"><table className="hr-table is-dense" aria-label={L("حسب المورد", "By supplier")} data-testid="claims-by-supplier">
        <thead><tr><th>{L("المورد", "Supplier")}</th><th className="num">{L("مطالبات", "Claims")}</th><th className="num">{L("أقدمها (يوم)", "Oldest (days)")}</th><th className="num">{L("المفتوح", "Open")}</th></tr></thead>
        <tbody>{d.suppliers.map((s) => <tr key={s.supplierId}><td><button type="button" className="hr-linkbtn" onClick={() => setSupplierId(s.supplierId)}>{s.name}</button></td><td className="num hr-num">{s.count}</td><td className="num hr-num">{s.oldestDays}{s.stale ? <span className="pur-tag is-warn">{L("متأخرة", "Overdue")}</span> : null}</td><td className="num hr-num">{money(s.openGross)}</td></tr>)}</tbody>
      </table></div> : null}
      <div className="hr-tablewrap">
        <table className="hr-table is-mrow" aria-label={L("مطالبات الموردين", "Supplier claims")} data-testid="claims-table">
          <thead><tr><th>{L("المورد", "Supplier")}</th><th>{L("الفاتورة", "Invoice")}</th><th className="hr-hide-compact">{L("الصنف", "Item")}</th><th className="num">{L("النقص", "Short")}</th><th className="num">{L("المفتوح (شامل الضريبة)", "Open (VAT incl.)")}</th><th>{L("العمر", "Age")}</th><th /></tr></thead>
          <tbody>
            {d.rows.map((c) => <tr key={c.id} data-testid={`claim-row-${c.id}`}>
              <td className="m-title"><span className="strong">{c.supplierName}</span><span className="hr-msub">{c.line.description} · <bdi className="acct-code">{c.invoice.number}</bdi>{c.status === "OPEN" ? <> · {L(`${c.ageDays} يومًا`, `${c.ageDays} days`)}{c.stale ? L(" · متأخرة", " · overdue") : ""}</> : null}</span></td>
              <td><Link className="acct-code pur-inv-link" href={`/dashboard/purchases/invoices/${c.invoice.id}`}>{c.invoice.number}</Link><span className="hr-caption"> · <bdi dir="ltr">{c.invoice.supplierRef}</bdi></span></td>
              <td className="hr-hide-compact">{c.line.description}</td>
              <td className="num hr-num">{c.openQty}{c.openQty !== c.qty ? <span className="hr-caption"> / {c.qty}</span> : null}</td>
              <td className="num hr-num m-end">{money(c.openGross)}</td>
              <td>{c.status === "OPEN" ? <span className={`hr-dot tone-${c.stale ? "danger" : "neutral"}`} data-testid={`claim-age-${c.id}`}><span>{L(`${c.ageDays} يومًا`, `${c.ageDays} days`)}{c.stale ? L(" · متأخرة", " · overdue") : ""}</span></span> : <span className={`hr-dot tone-${CLAIM_STATUS[c.status][2]}`}><span>{L(CLAIM_STATUS[c.status][0], CLAIM_STATUS[c.status][1])}</span></span>}</td>
              <td className="stk-macts"><ClaimActions c={c} can={d.can} onAct={setAct} /></td>
            </tr>)}
            {!d.rows.length ? <tr><td colSpan={7} className="acct-hint">{L("لا مطالبات.", "No claims.")}</td></tr> : null}
          </tbody>
        </table>
      </div>
      {act ? <ClaimDialog action={act} settings={d.settings} onClose={() => setAct(null)} onDone={(m) => { setAct(null); setDone(m); list.reload(); }} /> : null}
    </div>
  );
}

type Reliability = { from: string; to: string; rows: { supplierId: string; name: string; invoices: number; lines: number; shortLines: number; billed: string; received: string; fillRate: string | null; shortage: string; claimed: string; lost: string; absorbed: string; recovered: string; abandoned: string; recoveredPct: string | null }[] };

/** «موثوقية المورد» — per supplier over a period. */
export function ReliabilityBlock() {
  const { L } = useLang();
  const year = todayRiyadh().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayRiyadh());
  const r = useApi<Reliability>(`/api/purchases/suppliers/reliability?from=${from}&to=${to}`);
  return (
    <section className="hr-stack" aria-labelledby="pur-rel-h" data-testid="supplier-reliability">
      <h2 className="pi-h2" id="pur-rel-h">{L("موثوقية المورد", "Supplier reliability")} <span className="acct-hint">{L("الفواتير المعتمدة في الفترة · بالقيمة", "Approved invoices in the period · by value")}</span></h2>
      <div className="stk-tool">
        <label className="hr-field is-inline"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="rel-from" /></label>
        <label className="hr-field is-inline"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={to} max={todayRiyadh()} onChange={(e) => setTo(e.target.value)} data-testid="rel-to" /></label>
      </div>
      {r.error && !r.data ? <Notice tone="danger">{r.error}</Notice> : !r.data ? <OpsLoading /> : (
        <div className="hr-tablewrap"><table className="hr-table is-mrow" aria-label={L("موثوقية المورد", "Supplier reliability")} data-testid="reliability-table">
          <thead><tr><th>{L("المورد", "Supplier")}</th><th className="num">{L("نسبة التوريد", "Fill rate")}</th><th className="num">{L("قيمة النقص", "Shortage value")}</th><th className="num hr-hide-compact">{L("مطالَب به", "Claimed")}</th><th className="num">{L("المسترد", "Recovered")}</th><th className="num hr-hide-compact">{L("خسارة / ضمن التسامح", "Loss / within tolerance")}</th></tr></thead>
          <tbody>
            {r.data.rows.map((x) => <tr key={x.supplierId} data-testid={`rel-row-${x.supplierId}`}>
              <td className="m-title"><span className="strong">{x.name}</span><span className="hr-msub">{L(`${x.invoices} فاتورة · ${x.shortLines} سطر بنقص من ${x.lines}`, `${x.invoices} invoices · ${x.shortLines} of ${x.lines} lines short`)}<span className="pur-mobile-only"> · {L("التوريد", "fill")} {x.fillRate === null ? "—" : `${x.fillRate}%`} · {L("المسترد", "recovered")} {x.recoveredPct === null ? "—" : `${x.recoveredPct}%`}</span></span></td>
              <td className="num hr-num"><span className={x.fillRate !== null && Number(x.fillRate) < 98 ? "acct-bad" : ""}>{x.fillRate === null ? "—" : `${x.fillRate}%`}</span></td>
              <td className="num hr-num m-end">{money(x.shortage)}</td>
              <td className="num hr-num hr-hide-compact">{money(x.claimed)}</td>
              <td className="num hr-num">{x.recoveredPct === null ? "—" : `${x.recoveredPct}%`}<span className="hr-caption"> · {money(x.recovered)}</span></td>
              <td className="num hr-num hr-hide-compact">{money(x.lost)} / {money(x.absorbed)}</td>
            </tr>)}
            {!r.data.rows.length ? <tr><td colSpan={6} className="acct-hint">{L("لا فواتير معتمدة في الفترة.", "No approved invoices in the period.")}</td></tr> : null}
          </tbody>
        </table></div>
      )}
      <p className="acct-hint">{L("نسبة التوريد = قيمة المستلم ÷ قيمة المفوتر. المسترد = الإشعارات الدائنة والبضاعة البديلة ÷ المطالب به (التنازل ليس استردادًا).", "Fill rate = value received ÷ value billed. Recovered = credit notes and replacement goods ÷ claimed (an abandonment is not a recovery).")}</p>
    </section>
  );
}
