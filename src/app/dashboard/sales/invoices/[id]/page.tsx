"use client";

// The invoice / note detail (Figma ZT-01, ZT-12): the document, the payment and the e-invoicing states apart; the
// buyer and seller particulars; the lines and the E-10 totals; the notes against it, the receipts applied, the
// ledger entries it posted. A DRAFT is edited here (ZT-14) and issued through a confirmation (privileged + step-up);
// an issued document never changes — «إصدار إشعار دائن / مدين» is the only correction.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { D21Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { CATEGORY, DOC_STATUS, DocNo, FAMILY, InvShell, KIND, Msg, PAY_STATUS, REASONS, Tag, money, useApi, useLang, useWrite } from "../_ui/inv";
import { BuyerFields, LinesEditor, Totals, type Buyer, type EditLine } from "../_ui/editor";
import { ZatcaPanel } from "@/app/dashboard/accounting/zatca/_ui/zatca";
import { QRCodeSVG } from "qrcode.react";
import { Section } from "@/components/chrome";
import { useAccountantView } from "../../../accounting/_ui/qoyod-pages";

type Line = { id: string; description: string; skuCode: string | null; quantity: string; unit: "UNIT" | "KG"; unitPrice: string; discountPercent: string; discountAmount: string; taxCategory: "S" | "Z" | "E" | "O"; taxRatePercent: string; exemptionReasonCode: string | null; exemptionReason: string | null; lineNet: string; lineTax: string; lineTotal: string; orderItemId: string | null; productSkuId: string | null; originalLineId: string | null; deliveryId: string | null };
type Doc = {
  id: string; uuid: string; kind: string; family: "STANDARD" | "SIMPLIFIED"; status: string; number: string | null; customerId: string; orderId: string | null; source: string;
  originalInvoice: { id: string; number: string | null } | null; reasonCode: string | null; reason: string | null;
  issueDate: string | null; issueTime: string | null; supplyDate: string | null; dueDate: string | null; paymentTermsDays: number | null;
  totals: { lineExtension: string; discount: string; taxable: string; tax: string; grand: string };
  taxBreakdown: { category: string; rate: string; taxable: string; tax: string }[] | null;
  buyer: Buyer & Record<string, string | null>; seller: Record<string, unknown> | null; notes: string | null;
  createdById: string; issuedById: string | null; sodBypass: boolean; cancelledAt: string | null; cancelReason: string | null;
  lines: Line[]; notesIssued: { id: string; number: string | null; kind: string; status: string; grandTotal: string; reasonCode: string | null }[];
  applications: { id: string; collectionId: string | null; creditNoteId: string | null; amount: string; appliedDate: string; atReceipt: boolean; status: string }[];
  paid: string; open: string | null; creditLeft: string | null;
  entries: { id: string; ref: string | null; event: string | null; status: string }[];
  customer: { id: string; name: string; nameAr: string | null } | null; order: { id: string; orderNumber: number } | null; people: { id: string; name: string }[];
  can: { create: boolean; issue: boolean; cancel: boolean; creditNote: boolean; ar: boolean; self: boolean };
  zatca?: { qr: string | null; ref: string | null; status: string | null } | null;
};

const toEdit = (l: Line): EditLine => ({ description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxCategory: l.taxCategory, taxRatePercent: l.taxRatePercent, exemptionReasonCode: l.exemptionReasonCode, orderItemId: l.orderItemId, productSkuId: l.productSkuId, skuCode: l.skuCode, originalLineId: l.originalLineId, deliveryId: l.deliveryId });

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L, lang } = useLang();
  const qoyodView = useAccountantView();
  const router = useRouter();
  const doc = useApi<Doc>(`/api/sales/invoices/${id}`);
  const w = useWrite();
  const d = doc.data;
  type Form = { lines: EditLine[]; buyer: Buyer; family: "STANDARD" | "SIMPLIFIED"; supplyDate: string; terms: string; notes: string; reason: string };
  const [form, setForm] = useState<Form | null>(null);
  const [dialog, setDialog] = useState<"issue" | "cancel" | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [problems, setProblems] = useState<{ ar: string; en: string }[]>([]);
  // The draft's form: what the user typed, else the stored draft (no effect: derived on render).
  const f: Form | null = form ?? (d && d.status === "DRAFT" ? {
    lines: d.lines.map(toEdit),
    buyer: { name: d.buyer.name ?? "", vatNumber: d.buyer.vatNumber ?? "", crNumber: d.buyer.crNumber ?? "", city: d.buyer.city ?? "", district: d.buyer.district ?? "", street: d.buyer.street ?? "", buildingNo: d.buyer.buildingNo ?? "", postalCode: d.buyer.postalCode ?? "" },
    family: d.family, supplyDate: d.supplyDate ?? "", terms: d.paymentTermsDays != null ? String(d.paymentTermsDays) : "", notes: d.notes ?? "", reason: d.reason ?? "",
  } : null);
  const patch = (p: Partial<Form>) => { if (f) setForm({ ...f, ...p }); };
  const lines = f?.lines ?? null, buyer = f?.buyer ?? null, family = f?.family ?? "STANDARD", supplyDate = f?.supplyDate ?? "", terms = f?.terms ?? "", notes = f?.notes ?? "", reason = f?.reason ?? "";
  const setLines = (lines: EditLine[]) => patch({ lines }), setBuyer = (buyer: Buyer) => patch({ buyer }), setFamily = (family: "STANDARD" | "SIMPLIFIED") => patch({ family });
  const setSupplyDate = (supplyDate: string) => patch({ supplyDate }), setTerms = (terms: string) => patch({ terms }), setNotes = (notes: string) => patch({ notes }), setReason = (reason: string) => patch({ reason });
  if (!d) return <InvShell><Msg error={doc.error} />{doc.error ? null : <OpsLoading />}</InvShell>;

  const kindLabel = L(KIND[d.kind]?.[d.family]?.[0] ?? d.kind, KIND[d.kind]?.[d.family]?.[1] ?? d.kind);
  const isNote = d.kind !== "INVOICE";
  // Qoyod parity (accountant workspace only — QOYOD-REF §1.6): the settlement rows and «المبلغ المستحق» in the totals,
  // the «ملخص الضريبة» card (S / Z / E), the stored ZATCA QR on screen (only when it exists) and the bottom buttons in
  // Qoyod's order. Display only: the same document, the same links, no new action.
  const qoyod = qoyodView;
  const canEditDraft = d.status === "DRAFT" && (isNote ? d.can.creditNote : d.can.create);
  const canIssue = d.status === "DRAFT" && (isNote ? d.can.creditNote : d.can.issue);
  const person = (pid: string | null) => d.people.find((p) => p.id === pid)?.name ?? "—";
  const save = async () => {
    const r = await w.run("save", `/api/sales/invoices/${id}`, "PATCH", { family, buyer, supplyDate, paymentTermsDays: terms || undefined, notes, lines, ...(isNote ? { reason } : {}) }, L("حُفظت المسودة.", "Draft saved."));
    if (r) { setForm(null); doc.reload(); }
    return !!r;
  };
  const issue = async () => {
    setProblems([]);
    if (canEditDraft && !(await save())) { setDialog(null); return; }
    const res = await fetch(`/api/sales/invoices/${id}/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const b = await res.json().catch(() => ({}));
    setDialog(null);
    if (!res.ok) { w.setError(b.error ?? b.errorEn ?? `HTTP ${res.status}`); if (Array.isArray(b.problems)) setProblems(b.problems); return; }
    w.setDone(L(`صدرت برقم ${b.number}.`, `Issued as ${b.number}.`));
    doc.reload();
  };
  const cancel = async () => {
    const r = await w.run("cancel", `/api/sales/invoices/${id}/cancel`, "POST", { reason: cancelReason }, L("أُلغيت المسودة.", "Draft cancelled."));
    setDialog(null);
    if (r) doc.reload();
  };

  return (
    <InvShell title={d.number ? `${kindLabel} ${d.number}` : `${kindLabel} · ${L("مسودة", "draft")}`} testId="invoice-detail"
      meta={<span className="acct-meta"><Tag map={DOC_STATUS} value={d.status} /><span aria-hidden="true">·</span><bdi>{d.customer?.nameAr || d.customer?.name || d.buyer.name}</bdi>{d.order ? <><span aria-hidden="true">·</span><span>{L("طلب", "Order")} <bdi className="hr-num">#{d.order.orderNumber}</bdi></span></> : null}</span>}
      actions={
        <span className="acct-actions">
          <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}/print`} data-testid="open-print">{d.status === "DRAFT" ? L("معاينة الطباعة", "Print preview") : L("طباعة / PDF", "Print / PDF")}</Link>
          {d.status === "ISSUED" && d.kind === "INVOICE" && d.can.creditNote ? <>
            <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}/credit-note?kind=DEBIT_NOTE`} data-testid="new-debit-note">{L("إشعار مدين", "Debit note")}</Link>
            <Link className="hr-btn is-primary" href={`/dashboard/sales/invoices/${id}/credit-note`} data-testid="new-credit-note">{L("إصدار إشعار دائن", "Issue a credit note")}</Link>
          </> : null}
          {d.status === "DRAFT" && (isNote ? d.can.creditNote : d.can.cancel) ? <button type="button" className="hr-btn" onClick={() => setDialog("cancel")} data-testid="cancel-draft">{L("إلغاء المسودة", "Cancel draft")}</button> : null}
          {d.status === "DRAFT" && canIssue ? <button type="button" className="hr-btn is-primary" onClick={() => setDialog("issue")} data-testid="issue">{isNote ? L("إصدار الإشعار", "Issue the note") : L("إصدار الفاتورة", "Issue the invoice")}</button> : null}
        </span>
      }>
      <Msg error={w.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {problems.length ? <ul className="inv-check" data-testid="issue-problems">{problems.map((p, i) => <li key={i}>{L(p.ar, p.en)}</li>)}</ul> : null}

      <div className="acct-cards">
        <div className="acct-card" data-testid="state-document">
          <h3>{L("المستند", "Document")}</h3>
          <Tag map={DOC_STATUS} value={d.status} />
          <span className="acct-hint">{d.status === "ISSUED" ? L(`صدر ${d.issueDate} ${d.issueTime} · ${person(d.issuedById)}`, `Issued ${d.issueDate} ${d.issueTime} · ${person(d.issuedById)}`) : d.status === "CANCELLED" ? L(`أُلغيت: ${d.cancelReason}`, `Cancelled: ${d.cancelReason}`) : L(`أعدّها ${person(d.createdById)} · بلا رقم حتى الإصدار`, `Prepared by ${person(d.createdById)} · no number until issue`)}</span>
          {d.sodBypass ? <span className="inv-chip is-warn">{L("أصدرها مُعدّها (الوضع المبسّط)", "Issued by its preparer (simple mode)")}</span> : null}
        </div>
        {!isNote ? (
          <div className="acct-card" data-testid="state-payment">
            <h3>{L("السداد", "Payment")}</h3>
            {d.status === "ISSUED" ? <>
              <Tag map={PAY_STATUS} value={Number(d.open) <= 0 ? "PAID" : Number(d.paid) > 0 ? "PARTIAL" : "UNPAID"} />
              <span className="acct-hint">{L(`المسدَّد ${money(d.paid)} · المتبقي ${money(d.open)} · يستحق ${d.dueDate ?? "—"}`, `Paid ${money(d.paid)} · open ${money(d.open)} · due ${d.dueDate ?? "—"}`)}</span>
              <Link href={`/dashboard/sales/receivables/${d.customerId}`} className="acct-hint">{L("كشف حساب العميل", "Customer statement")}</Link>
            </> : <span className="acct-hint">{L("لا تُحصَّل قبل الإصدار", "Not collectable before issue")}</span>}
          </div>
        ) : (
          <div className="acct-card" data-testid="state-original">
            <h3>{L("الفاتورة الأصلية", "Original invoice")}</h3>
            {d.originalInvoice ? <Link href={`/dashboard/sales/invoices/${d.originalInvoice.id}`}><DocNo n={d.originalInvoice.number} /></Link> : "—"}
            <span className="acct-hint">{L("السبب: ", "Reason: ")}{d.reasonCode ? L(REASONS[d.reasonCode][0], REASONS[d.reasonCode][1]) : "—"}{d.reason ? ` — ${d.reason}` : ""}</span>
            {d.creditLeft !== null ? <span className="acct-hint">{L(`رصيد دائن غير مخصص ${money(d.creditLeft)}`, `Unapplied credit ${money(d.creditLeft)}`)}</span> : null}
          </div>
        )}
        <ZatcaPanel invoiceId={d.id} uuid={d.uuid} key={`${d.id}:${d.status}`} />
      </div>

      {d.status === "DRAFT" && canEditDraft && lines && buyer ? (
        <>
          <div className="acct-card">
            <div className="acct-row">
              {!isNote ? <label className="hr-field"><span className="hr-label">{L("نوع الفاتورة", "Invoice type")}</span>
                <Select value={family} onChange={(e) => setFamily(e.target.value === "SIMPLIFIED" ? "SIMPLIFIED" : "STANDARD")}>
                  <option value="STANDARD">{L("فاتورة ضريبية (منشأة)", "Tax invoice (business)")}</option>
                  <option value="SIMPLIFIED">{L("فاتورة ضريبية مبسطة (مستهلك)", "Simplified (consumer)")}</option>
                </Select></label> : null}
              <label className="hr-field"><span className="hr-label">{L("تاريخ التوريد", "Supply date")}</span><input type="date" className="hr-input" value={supplyDate} onChange={(e) => setSupplyDate(e.target.value)} /></label>
              {!isNote ? <label className="hr-field"><span className="hr-label">{L("مدة السداد (يوم)", "Payment terms (days)")}</span><input className="hr-input acct-amount" inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} /></label> : null}
              {isNote ? <label className="hr-field acct-grow"><span className="hr-label">{L("سبب الإصدار", "Reason")}</span><input className="hr-input" value={reason} onChange={(e) => setReason(e.target.value)} /></label> : null}
            </div>
            <h3>{L("بيانات المشتري", "Buyer particulars")}</h3>
            <BuyerFields buyer={buyer} family={family} onChange={setBuyer} />
          </div>
          <div className="acct-card">
            <h2>{L("البنود", "Lines")}</h2>
            <LinesEditor lines={lines} onChange={setLines} lockItems={d.kind === "CREDIT_NOTE"} />
            <div className="inv-grid2">
              <label className="hr-field"><span className="hr-label">{L("ملاحظات للعميل", "Notes to the customer")}</span><textarea className="hr-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
              <Totals lines={lines} />
            </div>
            <div className="acct-foot"><span className="acct-hint">{L("المسودة قابلة للتعديل حتى الإصدار.", "The draft can be edited until it is issued.")}</span>
              <button type="button" className="hr-btn" disabled={!!w.busy} onClick={save} data-testid="save-draft">{L("حفظ المسودة", "Save draft")}</button></div>
          </div>
        </>
      ) : (
        <>
          <div className="inv-grid2">
            <div className="acct-card">
              <dl className="acct-kv-grid">
                <div><dt>{L("المشتري", "Buyer")}</dt><dd><bdi>{d.buyer.name}</bdi></dd></div>
                <div><dt>{L("الرقم الضريبي للمشتري", "Buyer VAT")}</dt><dd className="acct-code">{d.buyer.vatNumber || "—"}</dd></div>
                <div><dt>{L("تاريخ التوريد", "Supply date")}</dt><dd className="hr-num">{d.supplyDate ?? "—"}</dd></div>
                <div><dt>{L("تاريخ الاستحقاق", "Due date")}</dt><dd className="hr-num">{d.dueDate ?? "—"}</dd></div>
                <div><dt>{L("النوع", "Type")}</dt><dd>{L(FAMILY[d.family][0], FAMILY[d.family][1])}</dd></div>
              </dl>
            </div>
            <div className="acct-card">
              <dl className="inv-totals" data-testid="doc-totals">
                <div><dt>{L("الإجمالي قبل الضريبة", "Total before VAT")}</dt><dd>{money(d.totals.taxable)}</dd></div>
                {(d.taxBreakdown ?? []).map((b) => <div key={`${b.category}${b.rate}`}><dt>{b.category === "S" ? L(`ضريبة القيمة المضافة ${Number(b.rate)}%`, `VAT ${Number(b.rate)}%`) : L(CATEGORY[b.category]?.[0] ?? b.category, CATEGORY[b.category]?.[1] ?? b.category)}</dt><dd>{money(b.tax)}</dd></div>)}
                <div className="g"><dt>{L("الإجمالي شامل الضريبة · ر.س", "Total incl. VAT · SAR")}</dt><dd data-testid="doc-grand">{money(d.totals.grand)}</dd></div>
                {qoyod && d.status === "ISSUED" ? <>
                  {d.applications.filter((a) => a.status === "APPLIED").map((a) => (
                    <div key={a.id} data-testid="doc-settlement"><dt>{a.collectionId ? L("دفعت بواسطة سند قبض", "Paid by a receipt") : L("دفعت بواسطة إشعار دائن", "Paid by a credit note")} · <span className="hr-num">{a.appliedDate}</span></dt><dd>{money(a.amount)}</dd></div>
                  ))}
                  <div className="g" data-testid="doc-due"><dt>{isNote ? L("الرصيد", "Balance") : L("المبلغ المستحق", "Amount due")}</dt><dd>{money(isNote ? d.creditLeft ?? "0" : d.open ?? "0")}</dd></div>
                </> : null}
              </dl>
            </div>
          </div>
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="doc-lines">
              <thead><tr><th>#</th><th>{L("الوصف", "Description")}</th><th className="num">{L("الكمية", "Qty")}</th><th className="num">{L("سعر الوحدة", "Unit price")}</th><th className="num">{L("الخصم", "Discount")}</th><th className="num">{L("قبل الضريبة", "Before VAT")}</th><th className="num">{L("الضريبة", "VAT")}</th><th className="num">{L("الإجمالي", "Total")}</th></tr></thead>
              <tbody>{d.lines.map((l, i) => (
                <tr key={l.id}><td className="hr-num">{i + 1}</td><td><bdi>{l.description}</bdi>{l.skuCode ? <span className="inv-sub acct-code">{l.skuCode}</span> : null}</td>
                  <td className="num hr-num">{l.quantity} {l.unit === "KG" ? L("كغ", "kg") : L("عبوة", "unit")}</td><td className="num hr-num">{money(l.unitPrice)}</td>
                  <td className="num hr-num">{Number(l.discountAmount) ? money(l.discountAmount) : "—"}</td><td className="num hr-num">{money(l.lineNet)}</td>
                  <td className="num hr-num">{money(l.lineTax)}<span className="inv-sub">{l.taxCategory === "S" ? `${Number(l.taxRatePercent)}%` : L(CATEGORY[l.taxCategory][0], CATEGORY[l.taxCategory][1])}</span></td><td className="num hr-num">{money(l.lineTotal)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {qoyod ? (() => {
            const by = (c: string) => (d.taxBreakdown ?? []).filter((b) => b.category === c);
            const sum = (c: string, k: "taxable" | "tax") => by(c).reduce((t, b) => t + Math.round(Number(b[k]) * 100), 0);
            const cats = ["S", "Z", "E"];
            const col = (c: string) => ({ taxable: sum(c, "taxable"), tax: sum(c, "tax") });
            const all = (d.taxBreakdown ?? []).reduce((t, b) => ({ taxable: t.taxable + Math.round(Number(b.taxable) * 100), tax: t.tax + Math.round(Number(b.tax) * 100) }), { taxable: 0, tax: 0 });
            const head: Record<string, string> = { S: L("«S» المعدل الأساسي", "«S» standard rate"), Z: L("«Z» الضريبة الصفرية", "«Z» zero-rated"), E: L("«E» معفى من الضريبة", "«E» exempt") };
            return (
              <Section title={L("ملخص الضريبة", "Tax summary")} testId="tax-summary">
                <div className="hr-tablewrap">
                  <table className="hr-table is-dense">
                    <thead><tr><th /> {cats.map((c) => <th key={c} className="num">{head[c]}</th>)}<th className="num">{L("الإجمالي", "Total")}</th></tr></thead>
                    <tbody>
                      {([["taxable", L("الإجمالي قبل الضريبة", "Before VAT")], ["tax", L("الضريبة", "VAT")], ["gross", L("الإجمالي بعد الضريبة", "After VAT")]] as const).map(([k, label]) => (
                        <tr key={k}><td>{label}</td>{cats.map((c) => { const v = col(c); return <td key={c} className="num hr-num">{money((k === "gross" ? v.taxable + v.tax : v[k]) / 100)}</td>; })}<td className="num hr-num">{money((k === "gross" ? all.taxable + all.tax : all[k]) / 100)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {d.zatca?.qr ? <div data-testid="doc-qr" style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}><QRCodeSVG value={d.zatca.qr} size={112} level="M" /><span className="acct-hint">{L("رمز QR المخزّن لهذه الفاتورة لدى الربط مع الهيئة.", "The QR stored for this invoice by the ZATCA integration.")}</span></div> : null}
              </Section>
            );
          })() : null}
          {d.notes ? <div className="acct-card"><h3>{L("ملاحظات", "Notes")}</h3><p style={{ margin: 0 }}><bdi>{d.notes}</bdi></p></div> : null}
        </>
      )}

      {d.notesIssued.length ? (
        <div className="acct-card" data-testid="notes-issued">
          <h3>{L("الإشعارات على هذه الفاتورة", "Notes against this invoice")}</h3>
          <ul className="ops-list">{d.notesIssued.map((n) => <li key={n.id}><Link href={`/dashboard/sales/invoices/${n.id}`}><DocNo n={n.number} draftLabel={L("مسودة", "draft")} /></Link> <span>{L(KIND[n.kind]?.STANDARD[0] ?? n.kind, KIND[n.kind]?.STANDARD[1] ?? n.kind)}</span> <Tag map={DOC_STATUS} value={n.status} /> <span className="hr-num">{money(n.grandTotal)}</span></li>)}</ul>
        </div>
      ) : null}
      {d.applications.length ? (
        <div className="acct-card" data-testid="applications">
          <h3>{L("ما سُدِّد منها", "Applied to it")}</h3>
          <ul className="ops-list">{d.applications.map((a) => <li key={a.id}><span>{a.collectionId ? L("تحصيل", "Receipt") : L("إشعار دائن", "Credit note")} · <span className="hr-num">{a.appliedDate}</span>{a.atReceipt ? L(" · عند الاعتماد", " · at approval") : ""}</span><span className="hr-num">{money(a.amount)}{a.status === "REVERSED" ? L(" (أُلغي)", " (reversed)") : ""}</span></li>)}</ul>
        </div>
      ) : null}
      {d.entries.length ? (
        <div className="acct-card" data-testid="entries">
          <h3>{L("القيود المحاسبية", "Journal entries")}</h3>
          <ul className="ops-list">{d.entries.map((e) => <li key={e.id}><Link href={`/dashboard/accounting/journals/${e.id}`} className="acct-code">{e.ref ?? e.id.slice(-6)}</Link><span>{e.event}</span></li>)}</ul>
        </div>
      ) : d.status === "ISSUED" ? <p className="acct-hint">{L("لم يُرحَّل قيد: المحاسبة غير مفعّلة أو المستند قبل تاريخ البدء.", "No entry: accounting is not active or the document precedes the go-live date.")}</p> : null}

      {dialog === "issue" ? (
        <D21Dialog lang={lang === "en" ? "en" : "ar"} title={isNote ? L("إصدار الإشعار", "Issue the note") : L("إصدار الفاتورة الضريبية", "Issue the tax invoice")} onClose={() => setDialog(null)} testId="issue-dialog"
          actions={<><button type="button" className="hr-btn is-primary" onClick={issue} data-testid="confirm-issue">{L("إصدار نهائي", "Issue (final)")}</button><button type="button" className="hr-btn" onClick={() => setDialog(null)}>{L("رجوع", "Back")}</button></>}>
          <p>{L("يُعطى المستند رقمًا نهائيًا متسلسلًا وتُثبَّت بيانات البائع والمشتري والبنود. لا يمكن تعديله بعد الإصدار؛ التصحيح بإشعار دائن أو مدين.", "The document gets its final sequential number and its particulars freeze. It cannot be edited after issue; corrections are credit or debit notes.")}</p>
          <p className="acct-hint">{L("يُرحَّل القيد في الدفاتر إن كانت المحاسبة مفعّلة.", "The journal entry is posted if accounting is active.")}</p>
        </D21Dialog>
      ) : null}
      {dialog === "cancel" ? (
        <D21Dialog lang={lang === "en" ? "en" : "ar"} title={L("إلغاء المسودة", "Cancel the draft")} onClose={() => setDialog(null)} testId="cancel-dialog"
          actions={<><button type="button" className="hr-btn is-danger" disabled={cancelReason.trim().length < 3} onClick={cancel} data-testid="confirm-cancel">{L("إلغاء المسودة", "Cancel draft")}</button><button type="button" className="hr-btn" onClick={() => setDialog(null)}>{L("رجوع", "Back")}</button></>}>
          <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}</span><input className="hr-input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} data-testid="cancel-reason" /></label>
        </D21Dialog>
      ) : null}
      {qoyod && d.status === "ISSUED" ? (() => {
        const deliveries = Array.from(new Set(d.lines.map((l) => l.deliveryId).filter((x): x is string => !!x)));
        return (
          <div className="acct-actions" data-testid="doc-bottom-actions" style={{ marginBlock: 16 }}>
            <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}/print`}>{L("طباعة", "Print")}</Link>
            {deliveries.length ? <Link className="hr-btn" href={`/dashboard/orders/print/delivery-note?ids=${deliveries.map(encodeURIComponent).join(",")}`}>{L("طباعة سند التسليم", "Print delivery note")}</Link> : null}
            <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}/print`}>{L("تحميل PDF", "Download PDF")}</Link>
            {d.zatca?.ref ? <a className="hr-btn" href={`/api/sales/invoices/${id}/zatca/xml`} download>{L("تحميل XML", "Download XML")}</a> : null}
            {d.kind === "INVOICE" && d.can.creditNote ? <>
              <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}/credit-note`}>+ {L("إرجاع الفاتورة (إشعار دائن)", "Return the invoice (credit note)")}</Link>
              <Link className="hr-btn" href={`/dashboard/sales/invoices/${id}/credit-note?kind=DEBIT_NOTE`}>+ {L("إنشاء إشعار مدين للمبيعات", "Create a sales debit note")}</Link>
            </> : null}
          </div>
        );
      })() : null}
      <p className="acct-hint"><button type="button" className="hr-btn is-ghost is-sm" onClick={() => router.push("/dashboard/sales/invoices")}>{L("كل الفواتير", "All invoices")}</button></p>
    </InvShell>
  );
}
