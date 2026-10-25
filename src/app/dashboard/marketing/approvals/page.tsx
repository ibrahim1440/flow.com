"use client";

import Link from "next/link";
import { useState } from "react";
import { useLang, PageHeader, Spinner, Banner, Sec, Button, StatusChip, Chip, useLoad, useMkt, usePageTitle, api, fmtDate, APPROVAL_STATUS, Modal, Field, TextArea, Alert } from "../_components/ui";

/**
 * «الموافقات» — every marketing request awaiting a second person. The approver sees the exact
 * snapshot submitted; if the subject changed afterwards the approval is refused as stale. Nobody can
 * decide their own request (the button is not offered, the API refuses, the database CHECK refuses).
 */

type Row = { id: string; subjectType: string; subjectId: string; subjectTitle: string | null; action: string; status: string; payload: Record<string, unknown>; requestedByName: string | null; requestNote: string | null; decidedByName: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null; canDecide: boolean; requestedById: string };

const TYPES: Record<string, string> = { POST: "منشور", CAMPAIGN: "حملة", MESSAGE_CAMPAIGN: "حملة رسائل واتساب", JOURNEY: "رحلة عملاء آلية", BUDGET_CHANGE: "تغيير ميزانية", AD_CHANGE: "تعديل إعلان", TRACKING_CHANGE: "إعداد تتبع", SENSITIVE_REPLY: "رد حساس" };
const ACTIONS: Record<string, string> = { publish: "نشر", ai_publish: "نشر محتوى مولّد بالذكاء الاصطناعي", activate: "تفعيل", pause: "إيقاف", send: "إرسال" };
const link = (r: Row) => (r.subjectType === "POST" ? `/dashboard/marketing/calendar?post=${r.subjectId}` : r.subjectType === "CAMPAIGN" || r.subjectType === "MESSAGE_CAMPAIGN" ? `/dashboard/marketing/campaigns/${r.subjectId}` : r.subjectType === "JOURNEY" ? "/dashboard/marketing/whatsapp" : null);

export default function ApprovalsPage() {
  const lang = useLang();
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
      <PageHeader title="الموافقات" subtitle="شخصان لكل إجراء حساس: مقدم الطلب لا يعتمده." />
      <div className="mkt-seg" role="group">{["PENDING", "APPROVED", "REJECTED", "CANCELLED", ""].map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? APPROVAL_STATUS[s].ar : "الكل"}</button>)}</div>
      <Banner onClose={() => setErr("")}>{err || error}</Banner>
      {!can("approve") ? <p className="mkt-muted">تستطيع متابعة طلباتك وسحبها؛ الاعتماد لمن يملك صلاحية «اعتماد طلبات التسويق».</p> : null}
      {loading && !data ? <Spinner /> : data && data.rows.length === 0 ? <Sec title="لا طلبات"><p className="mkt-muted">لا توجد طلبات بهذه الحالة.</p></Sec> : (
        <div className="mkt-list" data-testid="approvals">{data?.rows.map((r) => (
          <div key={r.id} className="mkt-item" data-testid={`approval-${r.id}`}>
            <div style={{ minWidth: 0 }}>
              <div className="t">{TYPES[r.subjectType] ?? r.subjectType} · {ACTIONS[r.action] ?? r.action}: {link(r) ? <Link href={link(r)!}>{r.subjectTitle ?? r.subjectId}</Link> : r.subjectTitle ?? r.subjectId}</div>
              <div className="s">طلبه {r.requestedByName} · {fmtDate(r.createdAt, true)}{r.requestNote ? ` · «${r.requestNote}»` : ""}</div>
              {r.decidedByName ? <div className="s">قرار {r.decidedByName} · {fmtDate(r.decidedAt, true)}{r.decisionNote ? ` · «${r.decisionNote}»` : ""}</div> : null}
              <details><summary className="mkt-muted">ما الذي سيُعتمد بالضبط</summary><pre className="mkt-pre" dir="ltr" style={{ fontSize: 12 }}>{JSON.stringify(r.payload, null, 2)}</pre></details>
            </div>
            <div className="mkt-toolbar">
              <StatusChip map={APPROVAL_STATUS} value={r.status} />
              {r.subjectType === "POST" && r.action === "ai_publish" ? <Chip tone="info">AI</Chip> : null}
              {r.canDecide ? <><Button onClick={() => setDeciding({ row: r, decision: "APPROVE" })} testId={`approve-${r.id}`}>اعتماد</Button><Button variant="danger" onClick={() => setDeciding({ row: r, decision: "REJECT" })}>رفض</Button></> : null}
              {r.status === "PENDING" && r.requestedById === user?.id ? <Button variant="secondary" onClick={() => withdraw(r)}>سحب الطلب</Button> : null}
              {r.status === "PENDING" && r.requestedById === user?.id && can("approve") ? <span className="mkt-muted">لا يمكنك اعتماد طلبك</span> : null}
            </div>
          </div>
        ))}</div>
      )}
      {deciding ? <Decide {...deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); reload(); }} /> : null}
    </div>
  );
}

function Decide({ row, decision, onClose, onDone }: { row: Row; decision: "APPROVE" | "REJECT"; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    const r = await api(`/api/marketing/approvals/${row.id}`, { method: "POST", body: { decision, note } });
    if (!r.ok) return setErr(r.data.error ?? "");
    onDone();
  }
  return (
    <Modal title={decision === "APPROVE" ? "اعتماد الطلب" : "رفض الطلب"} onClose={onClose} testId="decide" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button variant={decision === "APPROVE" ? "primary" : "danger"} onClick={save} testId="decide-save">{decision === "APPROVE" ? "تأكيد الاعتماد" : "تأكيد الرفض"}</Button></>}>
      {err ? <Alert kind="error">{err}</Alert> : null}
      <p>{row.subjectTitle}</p>
      <Field id="note" label={decision === "REJECT" ? "سبب الرفض (مطلوب)" : "ملاحظة (اختيارية)"}><TextArea id="note" value={note} onChange={setNote} /></Field>
    </Modal>
  );
}
