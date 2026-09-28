"use client";

// Figma: ACC-43. Inventory document detail: approval timeline with the actions the signed-in user
// may take, lines (with posted cost), the production loss calculation against the approved band,
// the journal it will post (or posted, built only from the sealed cost moves), the moves, and audit.
import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError, Badge, Button, Card, CardTitle, ErrorState, Field, INPUT, LoadingState, Notice, Table, Td, Th, useApi, useL } from "../../../../finance/_components/ui";
import { EVENT_STATUS, useAmount, useCan, useDay, useExplain } from "../../../_components/kit";
import { DocTypeLabel, InvStatus, qty } from "../../_ui";

type Loc = { code: string; name: string; nameAr: string | null } | null;
type Doc = {
  id: string; docNo: number; type: string; status: string; docDate: string; description: string | null; reason: string | null; issueReason: string | null; provisional: boolean;
  costMethod: string | null; priceDifference: string | null; amount: string | null; allocationBasis: string | null; lossBandPercent: string | null; sourceType: string | null; sourceId: string | null;
  createdBy: string; createdAt: string; submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null; postedBy: string | null; postedAt: string | null;
  rejectedReason: string | null; location: Loc; toLocation: Loc; supplier: string | null; customer: string | null;
  billLine: { billNo: number; invoiceNo: string; supplier: string; description: string | null; net: string } | null;
  names: Record<"createdBy" | "submittedBy" | "approvedBy" | "postedBy" | "rejectedBy", string | null>;
  lines: { id: string; lineNo: number; role: string; item: { code: string; name: string; kind: string; baseUnit: string; yieldPerUnit: string }; quantity: string; unit: string; factor: string; baseQty: string; unitCost: string | null; countedQty: string | null; description: string | null;
    posted: { qty: string; value: string; expensed: string; unitCost: string | null } | null }[];
  moves: { id: string; lineId: string | null; kind: string; qty: string; value: string; location: string }[];
  production: { yieldIn: string; yieldOut: string; bandPercent: string | null; band: { code: string; name: string; status: string } | null; expectedYield: string | null; lossQty: string; abnormalQty: string; inputValue: string | null; outputValue: string | null; abnormalValue: string | null } | null;
  ledger: { status: string; reason: string | null; entryNo: number | null; provisional: boolean | null; lines: { account: string; debit: string; credit: string }[] } | null;
  preview: { account: string; debit: string; credit: string }[] | null;
  audit: { action: string; at: string; by: string | null; reason: string | null }[];
};

const ROLE: Record<string, [string, string, "info" | "ok" | "warn"]> = { INPUT: ["مدخل", "Input", "info"], OUTPUT: ["مخرج", "Output", "ok"], LINE: ["بند", "Line", "info"] };
const MOVE: Record<string, [string, string]> = { IN: ["وارد", "In"], OUT: ["صادر", "Out"], REVALUE: ["إعادة تقييم", "Revalue"], EXPENSED: ["إلى المصروف", "Expensed"] };
const SOURCE: Record<string, [string, string]> = { ROASTING_BATCH: ["دُفعة التحميص", "roasting batch"], PURCHASE_RECORD: ["سجل الشراء", "purchase record"], SALES_INVOICE: ["فاتورة المبيعات", "sales invoice"], SALES_INVOICE_REVERSAL: ["عكس فاتورة المبيعات", "sales invoice reversal"] };

export default function InventoryDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { L } = useL();
  const amt = useAmount();
  const day = useDay();
  const explain = useExplain();
  const { can, user } = useCan();
  const { data: d, error, reload } = useApi<Doc>(`/api/accounting/inventory/documents/${id}`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!d) return <LoadingState />;

  const when = (t: string | null) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " ·") : "");
  const loc = (l: Loc) => (l ? `${l.code} · ${L(l.nameAr ?? l.name, l.name)}` : "—");
  const mine = user?.id === d.createdBy || user?.id === d.submittedBy;
  const system = d.createdBy.startsWith("system:");
  const act = async (path: string, json: unknown = {}) => {
    setBusy(path); setMsg(null);
    try {
      const r = await api<{ ledger?: { status: string; message?: string } | null }>(`/api/accounting/inventory/documents/${d.id}/${path}`, { method: "POST", json });
      if (r?.ledger && r.ledger.status !== "TRANSLATED" && r.ledger.status !== "SKIPPED") setMsg({ tone: "warn", text: L(`رُحّل المستند، والقيد ${EVENT_STATUS[r.ledger.status]?.ar ?? r.ledger.status}: ${explain(r.ledger.message)}`, `Document posted; the journal is ${r.ledger.status.toLowerCase()}: ${r.ledger.message ?? ""}`) });
      setReason(""); reload();
    } catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
    setBusy("");
  };
  const steps = [
    { title: system ? L("أنشأه النظام", "Created by the system") : L("أُعدّ كمسودة", "Drafted"), who: `${d.names.createdBy ?? "—"} · ${when(d.createdAt)}`, state: "done" },
    { title: L("قُدّم للاعتماد", "Submitted"), who: d.submittedBy ? `${d.names.submittedBy} · ${when(d.submittedAt)}` : "", state: d.submittedBy || d.status !== "DRAFT" ? "done" : "todo" },
    { title: d.status === "SUBMITTED" ? L("بانتظار الاعتماد", "Awaiting approval") : L("اعتُمد", "Approved"), who: d.approvedBy ? `${d.names.approvedBy} · ${when(d.approvedAt)}` : L("أي معتمد عدا المُعِدّ", "Any approver except the preparer"), state: d.approvedBy ? "done" : d.status === "SUBMITTED" ? "now" : "todo" },
    { title: L("رُحّل: حركات التكلفة والقيد", "Posted: cost moves and journal"), who: d.postedBy ? `${d.names.postedBy} · ${when(d.postedAt)}` : L("بعد الاعتماد", "After approval"), state: d.postedBy ? "done" : d.status === "APPROVED" ? "now" : "todo" },
  ];
  const dot = { done: "bg-green-600", now: "bg-amber-600", todo: "bg-gray-300" } as Record<string, string>;
  const reasonOk = reason.trim().length >= 5;
  const p = d.production;
  const posted = d.status === "POSTED";
  const tot = (k: "debit" | "credit", rows: { debit: string; credit: string }[]) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0).toFixed(2);
  const sub = [
    d.supplier && L(`المورد ${d.supplier}`, `Supplier ${d.supplier}`), d.customer && L(`العميل ${d.customer}`, `Customer ${d.customer}`),
    d.sourceType && L(`من ${SOURCE[d.sourceType]?.[0] ?? d.sourceType}`, `From the ${SOURCE[d.sourceType]?.[1] ?? d.sourceType}`),
    loc(d.location) + (d.toLocation ? ` → ${loc(d.toLocation)}` : ""),
    d.costMethod && L(d.costMethod === "FIFO" ? "الوارد أولاً صادر أولاً" : "المتوسط المرجح", d.costMethod === "FIFO" ? "FIFO" : "weighted average"),
    d.provisional && L("مؤقت (اختبار)", "provisional (test)"),
  ].filter(Boolean).join(" · ");

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr] items-start">
      <Card className="order-2 lg:order-1">
        <CardTitle title={L("الاعتماد", "Approval")} sub={L("فصل المهام: من أعدّ المستند لا يعتمده", "Separation of duties: the preparer cannot approve")} />
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3 items-start">
              <span className={`mt-1.5 w-3 h-3 rounded-full flex-shrink-0 ${dot[s.state]}`} aria-hidden />
              <div><p className={`text-[13px] font-bold ${s.state === "todo" ? "text-brown" : "text-charcoal"}`}>{s.title}</p>{s.who && <p className="text-[11px] text-brown">{s.who}</p>}</div>
            </li>
          ))}
        </ol>
        {d.rejectedReason && d.status === "DRAFT" && <Notice tone="bad">{L(`رُفض: ${d.rejectedReason} — ${d.names.rejectedBy ?? ""}`, `Rejected: ${d.rejectedReason} — ${d.names.rejectedBy ?? ""}`)}</Notice>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {d.status === "DRAFT" && can("inv_doc_create") && (
          <div className="flex gap-2 flex-wrap">
            <Button kind="primary" busy={busy === "submit"} disabled={!!busy} className="min-h-11" onClick={() => act("submit")}>{L("تقديم للاعتماد", "Submit for approval")}</Button>
            <Link href={`/dashboard/accounting/inventory/documents/new?edit=${d.id}&type=${d.type}`}><Button className="min-h-11">{L("تعديل", "Edit")}</Button></Link>
            <Button kind="danger" disabled={!!busy} className="min-h-11" onClick={async () => {
              if (!confirm(L("حذف المسودة؟", "Delete the draft?"))) return;
              try { await api(`/api/accounting/inventory/documents/${d.id}`, { method: "DELETE" }); router.push("/dashboard/accounting/inventory/documents"); }
              catch (e) { setMsg({ tone: "bad", text: e instanceof ApiError ? e.message : String(e) }); }
            }}>{L("حذف", "Delete")}</Button>
          </div>
        )}
        {d.status === "SUBMITTED" && can("inv_doc_approve") && (mine
          ? <Notice tone="info">{L("أنت من أعدّ أو قدّم هذا المستند؛ يعتمده شخص آخر.", "You prepared or submitted this document; someone else approves it.")}</Notice>
          : <>
            <Field label={L("سبب الرفض (مطلوب عند الرفض)", "Reason (required to reject)")} hint={L("5 أحرف على الأقل — يُحفظ في سجل التدقيق", "At least 5 characters — kept in the audit trail")}>
              <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button kind="primary" busy={busy === "approve"} disabled={!!busy} className="min-h-11 flex-1 lg:flex-none" onClick={() => act("approve")}>{L("اعتماد", "Approve")}</Button>
              <Button kind="danger" busy={busy === "reject"} disabled={!!busy || !reasonOk} className="min-h-11 flex-1 lg:flex-none" onClick={() => act("reject", { reason })}>{L("رفض وإرجاع كمسودة", "Reject to draft")}</Button>
            </div>
          </>)}
        {d.status === "APPROVED" && can("inv_doc_post") && <Button kind="primary" busy={busy === "post"} disabled={!!busy} className="min-h-11" onClick={() => act("post")}>{L("ترحيل المستند", "Post the document")}</Button>}
        <p className="text-[11px] text-brown">{L("الحركات المرحّلة لا تُعدَّل ولا تُحذف (قاعدة البيانات ترفض ذلك). التصحيح بمستند مقابل.", "Posted moves cannot be edited or deleted (the database refuses). Corrections use a counter document.")}</p>
      </Card>

      <div className="flex flex-col gap-4 order-1 lg:order-2 min-w-0">
        <Card>
          <CardTitle title={<><DocTypeLabel type={d.type} reason={d.issueReason} />{` #${d.docNo} · ${day(d.docDate)}`}</>} sub={sub}
            right={<InvStatus status={d.status} rejected={!!d.rejectedReason} ledger={d.ledger} provisional={d.provisional} />} />
          {d.description && <p className="text-[13px] text-charcoal">{d.description}</p>}
          {p && posted && (
            <div className="flex gap-6 flex-wrap">
              {[[L("قيمة المدخلات", "Input value"), amt(p.inputValue)], [L("قيمة المخرجات", "Output value"), amt(p.outputValue)],
                [L("تكلفة الكغ المحمّص", "Cost per kg out"), Number(p.yieldOut) ? qty((Number(p.outputValue) / Number(p.yieldOut)).toFixed(4)) : "—"]].map(([l, v]) => (
                <div key={l}><p className="text-xs font-bold text-brown">{l}</p><p className="text-xl font-extrabold text-charcoal tabular-nums">{v}</p></div>
              ))}
              <div><p className="text-xs font-bold text-brown">{L("الفاقد غير الطبيعي", "Abnormal loss")}</p><p className={`text-xl font-extrabold tabular-nums ${Number(p.abnormalValue) > 0 ? "text-red-700" : "text-charcoal"}`}>{amt(p.abnormalValue)}</p></div>
            </div>
          )}
          {d.billLine && <Notice tone="info">{L(`فاتورة المورد ف-${d.billLine.billNo} (${d.billLine.invoiceNo}) · ${d.billLine.supplier} · ${d.billLine.description ?? ""} · صافي ${amt(d.billLine.net)}`, `Supplier bill B-${d.billLine.billNo} (${d.billLine.invoiceNo}) · ${d.billLine.supplier} · ${d.billLine.description ?? ""} · net ${amt(d.billLine.net)}`)}</Notice>}
          {d.amount && d.type === "LANDED_COST" && <p className="text-[13px]">{L(`المبلغ الموزّع ${amt(d.amount)} حسب ${d.allocationBasis === "QUANTITY" ? "الكمية" : "القيمة"}`, `Amount ${amt(d.amount)} spread by ${d.allocationBasis === "QUANTITY" ? "quantity" : "value"}`)}</p>}
          <Table>
            <thead><tr><Th>{L("الدور", "Role")}</Th><Th>{L("الصنف", "Item")}</Th><Th num>{L("الكمية", "Quantity")}</Th><Th num>{L("بالوحدة الأساسية", "Base quantity")}</Th>
              {d.type === "COUNT" && <Th num>{L("المعدود", "Counted")}</Th>}<Th num>{L("تكلفة الوحدة", "Unit cost")}</Th><Th num>{L("التكلفة", "Cost")}</Th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id}>
                <Td><Badge tone={ROLE[l.role]?.[2] ?? "info"}>{L(ROLE[l.role]?.[0] ?? l.role, ROLE[l.role]?.[1] ?? l.role)}</Badge></Td>
                <Td>{l.item.name} · {l.item.code}{l.description ? <span className="block text-[11px] text-brown">{l.description}</span> : null}</Td>
                <Td num>{qty(l.quantity)} {l.unit}</Td><Td num>{qty(l.baseQty)} {l.item.baseUnit}</Td>
                {d.type === "COUNT" && <Td num>{qty(l.countedQty)}</Td>}
                <Td num>{qty(l.posted?.unitCost ?? l.unitCost)}</Td>
                <Td num>{l.posted ? amt(Math.abs(Number(l.posted.value)).toFixed(2)) : l.unitCost ? amt((Number(l.baseQty) * Number(l.unitCost)).toFixed(2)) : L("عند الترحيل", "On posting")}{l.posted && Number(l.posted.expensed) ? <span className="block text-[11px] text-brown">{L(`منها للمصروف ${amt(l.posted.expensed)}`, `expensed ${amt(l.posted.expensed)}`)}</span> : null}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>

        {p && (
          <Card>
            <CardTitle title={L("حساب الفاقد (قرار D-1)", "Loss calculation (decision D-1)")} sub={L("الفاقد داخل النطاق يُمتص في تكلفة المخرجات؛ ما يتجاوزه يُقيَّم بتكلفة وحدة المخرجات المتوقعة", "Loss within the band is absorbed into output cost; loss beyond it is valued at the expected output unit cost")} />
            <Table>
              <thead><tr><Th>{L("البند", "Item")}</Th><Th num>{L("الكمية (كغ)", "Quantity (kg)")}</Th><Th num>{L("القيمة", "Value")}</Th></tr></thead>
              <tbody>
                <tr><Td>{L("وزن المدخلات القابلة للعائد", "Yielding input weight")}</Td><Td num>{qty(p.yieldIn)}</Td><Td num>{posted ? amt(p.inputValue) : ""}</Td></tr>
                <tr><Td>{p.bandPercent ? L(`العائد المتوقع عند حد النطاق: ${Number(p.yieldIn)} × (100% − ${Number(p.bandPercent)}%)`, `Expected yield at the band limit: ${Number(p.yieldIn)} × (100% − ${Number(p.bandPercent)}%)`) : L("العائد المتوقع — لا نطاق فاقد معتمد", "Expected yield — no approved loss band")}</Td><Td num>{qty(p.expectedYield)}</Td><Td num /></tr>
                <tr><Td>{L("العائد الفعلي", "Actual yield")}</Td><Td num>{qty(p.yieldOut)}</Td><Td num>{posted ? amt(p.outputValue) : ""}</Td></tr>
                <tr><Td>{L("فاقد طبيعي (داخل النطاق) — ممتص", "Normal loss (within the band) — absorbed")}</Td><Td num>{qty((Number(p.lossQty) - Number(p.abnormalQty)).toFixed(4))}</Td><Td num>—</Td></tr>
                <tr className="text-red-700 font-bold"><Td>{L("فاقد غير طبيعي → 5300", "Abnormal loss → 5300")}</Td><Td num>{qty(p.abnormalQty)}</Td><Td num>{posted ? amt(p.abnormalValue) : L("عند الترحيل", "On posting")}</Td></tr>
              </tbody>
            </Table>
            <p className="text-xs text-brown">{p.band ? L(`النطاق ${p.band.code} · ${p.band.name}${p.band.status !== "APPROVED" ? " (غير معتمد)" : ""}. `, `Band ${p.band.code} · ${p.band.name}${p.band.status !== "APPROVED" ? " (not approved)" : ""}. `) : ""}{L("مواد التغليف (أكياس، ملصقات) لا تُعدّ في العائد: تُحمَّل كاملة على المخرجات. عند عدة مخرجات تُوزَّع التكلفة بوزن العائد.", "Packaging (bags, labels) does not count toward yield: it is charged in full to the outputs. With several outputs, cost is spread by yield weight.")}</p>
          </Card>
        )}

        <Card>
          <CardTitle title={d.ledger?.entryNo ? L(`القيد المرحّل #${d.ledger.entryNo}`, `Posted journal #${d.ledger.entryNo}`) : L("القيد الذي سيُرحَّل", "Journal it will post")}
            sub={L("يُنشأ آلياً من حركات التكلفة المختومة · قيد واحد لكل مستند", "Built automatically from the sealed cost moves · one journal per document")}
            right={d.ledger?.provisional ? <Badge tone="warn">{L("مؤقت", "Provisional")}</Badge> : undefined} />
          {d.ledger && d.ledger.status !== "TRANSLATED" && d.ledger.status !== "SKIPPED" && <Notice tone="warn">{L(`حالة القيد: ${EVENT_STATUS[d.ledger.status]?.ar ?? d.ledger.status} — ${explain(d.ledger.reason)}`, `Journal status: ${d.ledger.status.toLowerCase()} — ${d.ledger.reason ?? ""}`)}</Notice>}
          {d.ledger?.status === "SKIPPED" && <p className="text-[13px] text-brown">{L("لا أثر محاسبي (تحويل داخل نفس الحساب).", "No ledger effect (a transfer within the same account).")}</p>}
          {(d.ledger?.lines.length ?? 0) > 0 ? (
            <Table>
              <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
              <tbody>
                {d.ledger!.lines.map((l, i) => <tr key={i}><Td>{l.account}</Td><Td num>{Number(l.debit) ? amt(l.debit) : ""}</Td><Td num>{Number(l.credit) ? amt(l.credit) : ""}</Td></tr>)}
                <tr className="bg-cream-dark font-extrabold"><Td>{L("متوازن ✓", "Balanced ✓")}</Td><Td num>{amt(tot("debit", d.ledger!.lines))}</Td><Td num>{amt(tot("credit", d.ledger!.lines))}</Td></tr>
              </tbody>
            </Table>
          ) : d.preview ? (
            <Table>
              <thead><tr><Th>{L("الحساب", "Account")}</Th><Th num>{L("مدين", "Debit")}</Th><Th num>{L("دائن", "Credit")}</Th></tr></thead>
              <tbody>{d.preview.map((l, i) => <tr key={i}><Td>{l.account}</Td><Td num>{l.debit === "cost" ? L("التكلفة", "Cost") : l.debit ? amt(l.debit) : ""}</Td><Td num>{l.credit === "cost" ? L("التكلفة", "Cost") : l.credit ? amt(l.credit) : ""}</Td></tr>)}</tbody>
            </Table>
          ) : !posted ? <p className="text-[13px] text-brown">{L("تُحسب المبالغ من طبقات التكلفة عند الترحيل.", "Amounts are computed from the cost layers when the document posts.")}</p> : null}
        </Card>

        {d.moves.length > 0 && (
          <Card>
            <CardTitle title={L("حركات التكلفة", "Cost moves")} sub={L("مختومة بعد الترحيل؛ مجموع الطبقات يساوي الحركات", "Sealed after posting; layers equal their moves")} />
            <Table>
              <thead><tr><Th>{L("النوع", "Kind")}</Th><Th>{L("الصنف", "Item")}</Th><Th>{L("الموقع", "Location")}</Th><Th num>{L("الكمية", "Quantity")}</Th><Th num>{L("القيمة", "Value")}</Th></tr></thead>
              <tbody>{d.moves.map((m) => { const l = d.lines.find((x) => x.id === m.lineId); return (
                <tr key={m.id}><Td>{L(MOVE[m.kind]?.[0] ?? m.kind, MOVE[m.kind]?.[1] ?? m.kind)}</Td><Td>{l ? `${l.item.code} · ${l.item.name}` : "—"}</Td><Td>{m.location}</Td><Td num>{qty(m.qty)}</Td><Td num>{amt(m.value)}</Td></tr>); })}</tbody>
            </Table>
          </Card>
        )}

        <Card>
          <CardTitle title={L("سجل التدقيق", "Audit trail")} sub={L("لا يمكن تعديله أو حذفه", "Cannot be edited or deleted")} />
          <Table>
            <thead><tr><Th>{L("الوقت", "Time")}</Th><Th>{L("الإجراء", "Action")}</Th><Th>{L("المستخدم", "User")}</Th><Th>{L("السبب", "Reason")}</Th></tr></thead>
            <tbody>{d.audit.map((a, i) => <tr key={i}><Td className="whitespace-nowrap">{when(a.at)}</Td><Td>{a.action.replace(/^inventory\./, "")}</Td><Td>{a.by ?? "—"}</Td><Td>{a.reason ?? "—"}</Td></tr>)}</tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
