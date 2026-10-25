"use client";
// «مساحة عملي · الفريق» (Figma WS-08, 1748:2793). The team = HR direct reports, or everyone with
// workspace › team_view. Workload per colleague, leave today, disabled accounts; the open work of an
// absent or disabled colleague, to give to someone else in one step (each task re-checked by the API).
import { useState } from "react";
import { Btn, Field, Notice, OpsBanner, OpsEmpty, OpsError, OpsLoading, useL } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { dayOf } from "@/lib/workspace/format";
import { DueText, PriorityMark, WsPage, WsShell, useLang, useNow, useSelection, useWs, wsFetch } from "../_components/kit";
import { TaskPane, usePeople } from "../_components/task-ui";

type Team = {
  allowed: boolean;
  members: { id: string; name: string; active: boolean; jobTitle: string | null; open: number; overdue: number; dueToday: number; onLeaveUntil: string | null }[];
  needsReassign: { id: string; title: string; dueAt: string; priority: "LOW" | "NORMAL" | "HIGH" | "URGENT"; status: string; version: number; assigneeId: string; assignee: { name: string; active: boolean }; reason: "DISABLED" | "ON_LEAVE"; overdue: boolean }[];
};

export default function TeamPage() {
  const L = useL();
  const lang = useLang();
  const now = useNow();
  const { data, error, loading, reload } = useWs<Team>("/api/workspace/team");
  const people = usePeople("assign");
  const [taskId, setTaskId] = useSelection("task");
  const [picked, setPicked] = useState<string[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reassign = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await wsFetch<{ reassigned: string[]; refused: { id: string; code: string }[] }>("/api/workspace/tasks/reassign", { json: { tasks: data!.needsReassign.filter((t) => picked.includes(t.id)).map((t) => ({ id: t.id, version: t.version })), assigneeId: to } });
      setToast(r.refused.length ? L(`أُعيد إسناد ${r.reassigned.length}، ورُفض ${r.refused.length} (تغيّرت أو لا تملك صلاحيتها).`, `${r.reassigned.length} reassigned, ${r.refused.length} refused.`) : L(`أُعيد إسناد ${r.reassigned.length} مهمة وأُبلغ المسؤول الجديد.`, `${r.reassigned.length} reassigned; the new owner was told.`));
      setPicked([]); reload();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <WsShell open={!!(taskId)}>
      <WsPage title={L("الفريق", "Team")} testId="ws-team">
        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}>{toast}</OpsBanner> : null}
        {err ? <Notice tone="danger">{err}</Notice> : null}
        {error ? <OpsError message={error.message} onRetry={reload} /> : null}
        {loading && !data ? <OpsLoading /> : null}
        {data && !data.allowed ? <OpsEmpty title={L("لا فريق لك هنا", "You have no team here")} body={L("يظهر الفريق لمن لديه موظفون يتبعونه في الموارد البشرية، أو لمن مُنح صلاحية عرض الفريق.", "The team shows your HR direct reports, or everyone if you were granted the team view.")} /> : null}
        {data?.allowed ? (
          <>
            <div className="hr-tablewrap">
              <table className="hr-table is-mrow" aria-label={L("أعباء الفريق", "Team workload")}>
                <thead><tr><th>{L("الموظف", "Colleague")}</th><th className="num">{L("مفتوحة", "Open")}</th><th className="num">{L("متأخرة", "Overdue")}</th><th className="num">{L("مستحقة اليوم", "Due today")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.id}>
                      <td className="m-title"><a className="strong" href={`/dashboard/workspace/tasks?scope=team&member=${m.id}`}>{m.name}</a>{m.jobTitle ? <span className="sub">{m.jobTitle}</span> : null}</td>
                      <td className="num hr-num">{m.open}</td>
                      <td className="num hr-num">{m.overdue ? <span className="ws-due is-overdue">{m.overdue}</span> : 0}</td>
                      <td className="num hr-num">{m.dueToday}</td>
                      <td>{!m.active ? <span className="hr-flag tone-danger"><span>{L("الحساب معطّل", "Account disabled")}</span></span> : m.onLeaveUntil ? <span className="hr-flag tone-info"><span>{L(`في إجازة حتى ${dayOf(`${m.onLeaveUntil}T09:00:00Z`, lang, now)}`, `On leave until ${dayOf(`${m.onLeaveUntil}T09:00:00Z`, lang, now)}`)}</span></span> : <span className="hr-caption">{L("متاح", "Available")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section aria-labelledby="ws-reassign" className="hr-stack">
              <h2 id="ws-reassign" className="hr-section">{L("يحتاج إعادة إسناد", "Needs reassigning")} <span className="hr-caption">· {data.needsReassign.length}</span></h2>
              {data.needsReassign.length === 0 ? <p className="hr-caption">{L("لا مهام مفتوحة لدى زميل غائب أو حساب معطّل.", "No open work with an absent colleague or a disabled account.")}</p> : (
                <>
                  <ul className="ws-rows">
                    {data.needsReassign.map((t) => (
                      <li key={t.id} className="ws-row">
                        <input type="checkbox" aria-label={L(`اختيار: ${t.title}`, `Select: ${t.title}`)} checked={picked.includes(t.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))} />
                        <button type="button" className="ws-row-main" onClick={() => setTaskId(t.id)}>
                          <span className="ws-row-title">{t.title}</span>
                          <span className="ws-row-meta"><span>{t.assignee.name} · {t.reason === "DISABLED" ? L("حساب معطّل", "disabled") : L("في إجازة", "on leave")}</span><DueText dueAt={t.dueAt} overdue={t.overdue} now={now} /><PriorityMark priority={t.priority} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="ws-bulk">
                    <Field label={L("إعادة إسناد المحدد إلى", "Reassign the selected to")}><Select className="hr-select" value={to} onChange={(e) => setTo(e.target.value)}>
                      <option value="">—</option>
                      {people.filter((p) => !data.needsReassign.some((t) => t.assigneeId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select></Field>
                    <Btn variant="primary" busy={busy} disabled={!picked.length || !to} onClick={() => void reassign()}>{L(`إعادة إسناد (${picked.length})`, `Reassign (${picked.length})`)}</Btn>
                  </div>
                </>
              )}
            </section>
          </>
        ) : null}
      </WsPage>
      {taskId ? <TaskPane id={taskId} onClose={() => setTaskId(null)} onChanged={(m) => { if (m) setToast(m); reload(); }} /> : null}
    </WsShell>
  );
}
