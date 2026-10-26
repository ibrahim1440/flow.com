"use client";

import Link from "next/link";
import { useState } from "react";
import { useLang, PageHeader, Spinner, Banner, Sec, Button, StatusChip, Chip, useLoad, useMkt, usePageTitle, api, fmtDate, APPROVAL_STATUS, Modal, Field, TextArea, Alert, specLabel } from "../_components/ui";

/**
 * «الموافقات» — every marketing request awaiting a second person. The approver sees the exact
 * snapshot submitted; if the subject changed afterwards the approval is refused as stale. Nobody can
 * decide their own request (the button is not offered, the API refuses, the database CHECK refuses).
 */

type Row = { id: string; subjectType: string; subjectId: string; subjectTitle: string | null; action: string; status: string; payload: Record<string, unknown>; requestedByName: string | null; requestNote: string | null; decidedByName: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null; canDecide: boolean; requestedById: string };

const TYPES: Record<string, { ar: string; en: string }> = {
  POST: { ar: "منشور", en: "Post" }, CAMPAIGN: { ar: "حملة", en: "Campaign" }, MESSAGE_CAMPAIGN: { ar: "حملة رسائل واتساب", en: "WhatsApp message campaign" },
  JOURNEY: { ar: "رحلة عملاء آلية", en: "Automated customer journey" }, BUDGET_CHANGE: { ar: "تغيير ميزانية", en: "Budget change" }, AD_CHANGE: { ar: "تعديل إعلان", en: "Ad change" },
  TRACKING_CHANGE: { ar: "إعداد تتبع", en: "Tracking setup" }, SENSITIVE_REPLY: { ar: "رد حساس", en: "Sensitive reply" },
};
const ACTIONS: Record<string, { ar: string; en: string }> = {
  publish: { ar: "نشر", en: "Publish" }, ai_publish: { ar: "نشر محتوى مولّد بالذكاء الاصطناعي", en: "Publish AI-generated content" }, activate: { ar: "تفعيل", en: "Activate" },
  pause: { ar: "إيقاف", en: "Pause" }, send: { ar: "إرسال", en: "Send" },
};
const link = (r: Row) => (r.subjectType === "POST" ? `/dashboard/marketing/calendar?post=${r.subjectId}` : r.subjectType === "CAMPAIGN" || r.subjectType === "MESSAGE_CAMPAIGN" ? `/dashboard/marketing/campaigns/${r.subjectId}` : r.subjectType === "JOURNEY" ? "/dashboard/marketing/whatsapp" : null);

export default function ApprovalsPage() {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  usePageTitle("الموافقات", "Approvals", lang);
  const { can, user } = useMkt();
  const [status, setStatus] = useState("PENDING");
  const { data, error, loading, reload } = useLoad<{ rows: Row[] }>(`/api/marketing/approvals?status=${status}`);
  const [deciding, setDeciding] = useState<{ row: Row; decision: "APPROVE" | "REJECT" } | null>(null);
  const [err, setErr] = useState("");

  async function withdraw(r: Row) {
    const res = await api(`/api/marketing/approvals/${r.id}`, { method: "DELETE" });
    if (!res.ok) return setErr(res.data.error ?? "");
    reload();
  }

  return (
    <div className="mkt" data-testid="mkt-approvals">
      <PageHeader title={L("الموافقات", "Approvals")} subtitle={L("شخصان لكل إجراء حساس: مقدم الطلب لا يعتمده.", "Two people for every sensitive action: the requester does not approve it.")} />
      <div className="mkt-seg" role="group">{["PENDING", "APPROVED", "REJECTED", "CANCELLED", ""].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? specLabel(APPROVAL_STATUS, s, lang) : L("الكل", "All")}</button>)}</div>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {!can("approve") ? <p className="mkt-muted">{L("تستطيع متابعة طلباتك وسحبها؛ الاعتماد لمن يملك صلاحية «اعتماد طلبات التسويق».", "You can follow and withdraw your requests; approving is for holders of the “Approve marketing requests” permission.")}</p> : null}
      {loading && !data ? <Spinner /> : data && data.rows.length === 0 ? <Sec title={L("لا طلبات", "No requests")}><p className="mkt-muted">{L("لا توجد طلبات بهذه الحالة.", "No requests with this status.")}</p></Sec> : (
        <div className="mkt-list" data-testid="approvals">{data?.rows.map((r) => (
          <div key={r.id} className="mkt-item" data-testid={`approval-${r.id}`}>
            <div style={{ minWidth: 0 }}>
              <div className="t">{specLabel(TYPES, r.subjectType, lang)} · {specLabel(ACTIONS, r.action, lang)}: {link(r) ? <Link href={link(r)!}>{r.subjectTitle ?? r.subjectId}</Link> : r.subjectTitle ?? r.subjectId}</div>
              <div className="s">{L("طلبه", "Requested by")} {r.requestedByName} · {fmtDate(r.createdAt, true)}{r.requestNote ? ` · «${r.requestNote}»` : ""}</div>
              {r.decidedByName ? <div className="s">{L("قرار", "Decided by")} {r.decidedByName} · {fmtDate(r.decidedAt, true)}{r.decisionNote ? ` · «${r.decisionNote}»` : ""}</div> : null}
              <details><summary className="mkt-muted">{L("ما الذي سيُعتمد بالضبط", "Exactly what will be approved")}</summary><pre className="mkt-pre" dir="ltr" style={{ fontSize: 12 }}>{JSON.stringify(r.payload, null, 2)}</pre></details>
            </div>
            <div className="mkt-toolbar">
              <StatusChip map={APPROVAL_STATUS} value={r.status} />
              {r.subjectType === "POST" && r.action === "ai_publish" ? <Chip tone="info">AI</Chip> : null}
              {r.canDecide ? <><Button onClick={() => setDeciding({ row: r, decision: "APPROVE" })} testId={`approve-${r.id}`}>{L("اعتماد", "Approve")}</Button><Button variant="danger" onClick={() => setDeciding({ row: r, decision: "REJECT" })}>{L("رفض", "Reject")}</Button></> : null}
              {r.status === "PENDING" && r.requestedById === user?.id ? <Button variant="secondary" onClick={() => withdraw(r)}>{L("سحب الطلب", "Withdraw request")}</Button> : null}
              {r.status === "PENDING" && r.requestedById === user?.id && can("approve") ? <span className="mkt-muted">{L("لا يمكنك اعتماد طلبك", "You cannot approve your own request")}</span> : null}
            </div>
          </div>
        ))}</div>
      )}
      {deciding ? <Decide {...deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); reload(); }} /> : null}
    </div>
  );
}

function Decide({ row, decision, onClose, onDone }: { row: Row; decision: "APPROVE" | "REJECT"; onClose: () => void; onDone: () => void }) {
  const lang = useLang();
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    const r = await api(`/api/marketing/approvals/${row.id}`, { method: "POST", body: { decision, note } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title={decision === "APPROVE" ? L("اعتماد الطلب", "Approve request") : L("رفض الطلب", "Reject request")} onClose={onClose} testId="decide" footer={<><Button variant="secondary" onClick={onClose}>{L("إلغاء", "Cancel")}</Button><Button variant={decision === "APPROVE" ? "primary" : "danger"} onClick={save} testId="decide-save">{decision === "APPROVE" ? L("تأكيد الاعتماد", "Confirm approval") : L("تأكيد الرفض", "Confirm rejection")}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p>{row.subjectTitle}</p>
      <Field id="note" label={decision === "REJECT" ? L("سبب الرفض (مطلوب)", "Reason for rejection (required)") : L("ملاحظة (اختيارية)", "Note (optional)")}><TextArea id="note" value={note} onChange={setNote} /></Field>
    </Modal>
  );
}
