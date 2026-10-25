"use client";
// «مساحة عملي · طلباتي» (Figma WS-07, 1748:2302 / 1748:2648). The person's own leave and advance requests,
// who holds the next step, the decision note; new requests with the HR self-service dialogs themselves
// (the same /api/hr/me endpoints, the same rules). The subject is always the session's own HR record.
import { useState } from "react";
import { Btn, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, useL } from "@/components/ops/ui";
import { ADVANCE_STATUS, REQUEST_STATUS, StatusDot, hrFetch, money } from "@/components/hr/ui";
import { LeaveRequestDialog, AdvanceRequestDialog, CancelRequestDialog } from "@/components/hr/self-requests";
import { dayOf, ago, monthOf } from "@/lib/workspace/format";
import { WsPage, WsShell, useLang, useNow, useWs } from "../_components/kit";

type Item = {
  type: "LEAVE" | "ADVANCE"; id: string; title: string; status: string; createdAt: string;
  startDate?: string; endDate?: string; days?: string; amount?: string; installmentCount?: number; firstInstallmentMonth?: string;
  reason?: string | null; decisionNote: string | null; cancelReason: string | null; decidedBy: string | null;
  step: { ar: string; en: string } | null; canWithdraw: boolean; canCancel: boolean;
};
type Requests = { linked: boolean; items: Item[] };

export default function RequestsPage() {
  const L = useL();
  const lang = useLang();
  const now = useNow();
  const { data, error, loading, reload } = useWs<Requests>("/api/workspace/requests");
  const [dialog, setDialog] = useState<null | "leave" | "advance" | { cancel: Item }>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = (m: string) => { setDialog(null); setToast(m); reload(); };
  const withdraw = async (i: Item) => {
    setBusy(i.id); setErr(null);
    try { await hrFetch(`/api/hr/me/leave/${i.id}/withdraw`, { json: {} }); done(L("سُحب الطلب.", "Request withdrawn.")); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  return (
    <WsShell>
    <WsPage title={L("طلباتي", "My requests")} testId="ws-requests" actions={data?.linked ? <>
      <Btn variant="primary" onClick={() => setDialog("leave")}>{L("طلب إجازة", "Request leave")}</Btn>
      <Btn onClick={() => setDialog("advance")}>{L("طلب سلفة", "Request an advance")}</Btn>
    </> : undefined}>
      {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}>{toast}</OpsBanner> : null}
      {err ? <Notice tone="danger">{err}</Notice> : null}
      {error ? <OpsError message={error.message} onRetry={reload} /> : null}
      {loading && !data ? <OpsLoading /> : null}
      {data && !data.linked ? <OpsEmpty title={L("حسابك غير مرتبط بملف موظف — اطلب من الموارد البشرية ربطه.", "Your login is not linked to an employee file — ask HR to link it.")} body={L("بعد الربط تظهر هنا طلبات إجازتك وسلفك وحالتها.", "Once linked, your leave and advance requests and their status appear here.")} /> : null}
      {data?.linked && data.items.length === 0 ? <OpsEmpty title={L("لا طلبات بعد", "No requests yet")} body={L("قدّم طلب إجازة أو سلفة من الأزرار أعلاه.", "Use the buttons above to request leave or an advance.")} /> : null}
      {data?.linked && data.items.length ? (
        <ul className="ws-rows ws-requests">
          {data.items.map((i) => (
            <li key={`${i.type}:${i.id}`} className="ws-row is-request">
              <div className="ws-row-main is-static">
                <span className="ws-row-title">{i.title}{i.type === "LEAVE" && i.startDate ? ` · ${dayOf(`${i.startDate}T09:00:00Z`, lang, now)}${i.endDate !== i.startDate ? ` — ${dayOf(`${i.endDate}T09:00:00Z`, lang, now)}` : ""} · ${Number(i.days)} ${L("يوم", "day(s)")}` : ""}{i.type === "ADVANCE" ? ` · ${money(i.amount)} ${L("ر.س", "SAR")} · ${i.installmentCount} ${L("أقساط من", "instalments from")} ${monthOf(i.firstInstallmentMonth ?? "", lang)}` : ""}</span>
                <span className="ws-row-meta">
                  <StatusDot map={i.type === "LEAVE" ? REQUEST_STATUS : ADVANCE_STATUS} value={i.status} />
                  {i.step ? <span>{lang === "ar" ? i.step.ar : i.step.en}</span> : null}
                  <span>{ago(i.createdAt, lang, now)}</span>
                </span>
                {i.decisionNote ? <span className="ws-note">{i.status === "REJECTED" ? L("سبب الرفض: ", "Reason: ") : L("ملاحظة: ", "Note: ")}{i.decisionNote}{i.decidedBy ? ` — ${i.decidedBy}` : ""}</span> : null}
                {i.cancelReason ? <span className="ws-note">{L("سبب الإلغاء: ", "Cancelled: ")}{i.cancelReason}</span> : null}
              </div>
              <div className="ws-row-actions">
                {i.canWithdraw ? <Btn size="sm" busy={busy === i.id} onClick={() => void withdraw(i)}>{L("سحب الطلب", "Withdraw")}</Btn> : null}
                {i.canCancel ? <Btn size="sm" variant="ghost" onClick={() => setDialog({ cancel: i })}>{i.type === "LEAVE" ? L("إلغاء الإجازة", "Cancel leave") : L("إلغاء الطلب", "Cancel request")}</Btn> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {dialog === "leave" ? <LeaveRequestDialog onClose={() => setDialog(null)} onDone={() => done(L("قُدّم طلب الإجازة وأُبلغ صاحب الاعتماد.", "Leave requested; the approver was told."))} /> : null}
      {dialog === "advance" ? <AdvanceRequestDialog onClose={() => setDialog(null)} onDone={() => done(L("قُدّم طلب السلفة.", "Advance requested."))} /> : null}
      {dialog && typeof dialog === "object" ? <CancelRequestDialog kind={dialog.cancel.type} id={dialog.cancel.id} onClose={() => setDialog(null)} onDone={() => done(L("أُلغي الطلب.", "Cancelled."))} /> : null}
    </WsPage>
    </WsShell>
  );
}
