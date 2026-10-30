"use client";
// «مساحة عملي» — a task's pane (side panel at 1440, drawer below 1280, sheet on the phone) and the
// dialogs: create, record a follow-up's result, give to someone else, a reason for hold / cancel / return.
// Buttons say what they do; success is shown only after the server confirmed it.
import { useEffect, useMemo, useState } from "react";
import { Btn, Field, Notice, OpsPane, useL } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { Dialog, HrApiError } from "@/components/hr/ui";
import { dueLabel } from "@/lib/workspace/format";
import { PRIORITY_LABEL, PRIORITIES } from "@/lib/workspace/rules";
import { toRiyadhLocal, parseRiyadhLocal } from "@/lib/workspace/time";
import { DueText, OUTCOMES, StatusChip, TypeChip, recordOf, useLang, useNow, useWs, wsFetch, type CrmDue, type ReorderDue, type Task } from "./kit";
import { suggestNextStep } from "@/lib/services/sales/follow-through";
import { EMPTY_QUALIFICATION, QualificationFields, missingText, qualificationPayload, type QualificationDraft } from "../../sales/_components/QualificationFields";

type Detail = {
  task: Task;
  checklist: { id: string; label: string; doneAt: string | null }[];
  comments: { id: string; body: string; createdAt: string; author: { id: string; name: string } }[];
  history: { id: string; action: string; at: string; actorName: string | null; data: Record<string, unknown> }[];
};
type Attachment = { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string; uploadedBy: { id: string; name: string } };

const ACTION_LABEL: Record<string, [string, string]> = {
  start: ["بدء المهمة", "Start task"], hold: ["إيقاف مؤقت", "Put on hold"], resume: ["استئناف المهمة", "Resume"],
  complete: ["إكمال المهمة", "Complete"], record_result: ["تسجيل النتيجة", "Record result"],
  approve_review: ["اعتماد الإنجاز", "Approve the work"], return: ["إعادة للتنفيذ", "Return for more work"], cancel: ["إلغاء المهمة", "Cancel task"],
};
const PRIMARY = ["start", "resume", "complete", "record_result", "approve_review"];
const HISTORY_LABEL: Record<string, [string, string]> = {
  CREATED: ["أُنشئت", "Created"], REASSIGNED: ["أُعيد إسنادها", "Reassigned"], STATUS: ["تغيّرت الحالة", "Status changed"], DUE_CHANGED: ["تغيّر الموعد", "Deadline changed"],
  UPDATED: ["عُدّلت", "Edited"], REVIEW_APPROVED: ["اعتُمد الإنجاز", "Work approved"], REVIEW_RETURNED: ["أُعيدت للتنفيذ", "Returned"],
  RESULT_RECORDED: ["سُجلت النتيجة", "Result recorded"], CANCELLED: ["أُلغيت", "Cancelled"], CHECKLIST: ["قائمة التحقق", "Checklist"],
  COMMENTED: ["تعليق", "Comment"], REMINDER_SNOOZED: ["تأجيل التذكير", "Reminder snoozed"],
};

/** The message of a refusal, with the stale case named plainly. */
function messageOf(e: unknown, L: (a: string, b: string) => string): string {
  if (e instanceof HrApiError && (e.code === "STALE" || e.code === "STALE_REQUEST")) return L("تغيّرت المهمة بعد فتحها. حدّثنا البيانات — راجعها ثم أعد المحاولة.", "The task changed after you opened it. It has been refreshed — review it and try again.");
  return e instanceof Error ? e.message : String(e);
}

export function TaskPane({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (msg?: string) => void }) {
  const L = useL();
  const lang = useLang();
  const now = useNow();
  const { data, error, loading, reload } = useWs<Detail>(`/api/workspace/tasks/${encodeURIComponent(id)}`);
  const atts = useWs<Attachment[]>(`/api/workspace/tasks/${encodeURIComponent(id)}/attachments`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [reason, setReason] = useState<null | "hold" | "cancel" | "return">(null);
  const [result, setResult] = useState(false);
  const [reassign, setReassign] = useState(false);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [newItem, setNewItem] = useState("");
  const t = data?.task;

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key); setErr(null); setOk(null);
    try {
      await fn();
      setOk(success);
      reload(); atts.reload();
      onChanged(success);
      return true;
    } catch (e) {
      setErr(messageOf(e, L));
      reload();
      return false;
    } finally {
      setBusy(null);
    }
  };
  const transition = (action: string, extra: Record<string, unknown> = {}) =>
    act(action, () => wsFetch(`/api/workspace/tasks/${id}/transition`, { json: { action, version: t!.version, ...extra } }), L(`تم: ${ACTION_LABEL[action][0]}`, `Done: ${ACTION_LABEL[action][1]}`));

  const title = t ? t.title : L("المهمة", "Task");
  const actions = t?.actions ?? [];
  const primary = actions.filter((a) => PRIMARY.includes(a));
  const secondary = actions.filter((a) => ["hold", "return", "cancel"].includes(a));

  const footer = t ? (
    <div className="ws-pane-actions">
      {primary.map((a) => (
        <Btn key={a} variant="primary" busy={busy === a} data-testid={`task-${a}`} onClick={() => {
          if (a === "record_result") setResult(true); else void transition(a);
        }}>{L(...ACTION_LABEL[a])}</Btn>
      ))}
      {secondary.map((a) => <Btn key={a} variant={a === "cancel" ? "danger" : "secondary"} data-testid={`task-${a}`} onClick={() => setReason(a as "hold" | "cancel" | "return")}>{L(...ACTION_LABEL[a])}</Btn>)}
      {actions.includes("edit") ? <Btn variant="ghost" onClick={() => setEditing(true)} data-testid="task-edit">{L("تعديل الموعد أو التفاصيل", "Edit deadline or details")}</Btn> : null}
      {actions.includes("reassign") ? <Btn variant="ghost" onClick={() => setReassign(true)}>{L("إعادة الإسناد", "Reassign")}</Btn> : null}
    </div>
  ) : null;

  return (
    <OpsPane label={L("تفاصيل المهمة", "Task details")} title={title} testId="task-pane" onClose={onClose} busy={!!busy} footer={footer} drawer="open"
      sub={t ? <><TypeChip type={t.kind} /> <StatusChip status={t.status} />{t.overdue ? <> <span className="ws-due is-overdue">{L("متأخرة", "Overdue")}</span></> : null}</> : null}>
      {error ? <Notice tone="danger">{error.message}</Notice> : null}
      {loading && !data ? <div className="hr-skel" style={{ width: "80%" }} /> : null}
      {ok ? <Notice tone="success">{ok}</Notice> : null}
      {err ? <Notice tone="danger">{err}</Notice> : null}
      {t ? (
        <div className="hr-stack">
          {t.status === "ON_HOLD" && t.holdReason ? <Notice tone="warning">{L("سبب التوقف: ", "On hold: ")}{t.holdReason}</Notice> : null}
          {t.completedLate ? <Notice tone="info">{L("اكتملت بعد موعدها النهائي.", "Completed after its deadline.")}</Notice> : null}
          <dl className="hr-kv ws-kv">
            <div><dt>{L("المسؤول", "Owner")}</dt><dd>{t.assignee.name}{!t.assignee.active ? <> · <span className="ws-due is-overdue">{L("الحساب معطّل", "Account disabled")}</span></> : null}</dd></div>
            {t.createdById !== t.assigneeId ? <div><dt>{L("أسندها", "Assigned by")}</dt><dd>{t.createdBy.name}</dd></div> : null}
            <div><dt>{L("الموعد النهائي", "Deadline")}</dt><dd><DueText dueAt={t.dueAt} overdue={t.overdue} now={now} /> <span className="hr-caption">({dueLabel(t.dueAt, lang, now)})</span></dd></div>
            <div><dt>{L("الأولوية", "Priority")}</dt><dd>{L(PRIORITY_LABEL[t.priority].ar, PRIORITY_LABEL[t.priority].en)}</dd></div>
            {recordOf(t) ? <div><dt>{L("مرتبطة بـ", "Linked to")}</dt><dd>{recordOf(t)}</dd></div> : null}
            {t.requiresReview ? <div><dt>{L("المراجعة", "Review")}</dt><dd>{t.reviewer?.name ?? t.createdBy.name}</dd></div> : null}
            {t.recurRule ? <div><dt>{L("التكرار", "Repeats")}</dt><dd>{L({ DAILY: "يوميًا", WEEKLY: "أسبوعيًا", MONTHLY: "شهريًا" }[t.recurRule] ?? "", t.recurRule.toLowerCase())}{t.recurInterval && t.recurInterval > 1 ? ` × ${t.recurInterval}` : ""}</dd></div> : null}
            {t.remindBeforeMinutes ? <div><dt>{L("التذكير", "Reminder")}</dt><dd>{L(`قبل ${t.remindBeforeMinutes} دقيقة`, `${t.remindBeforeMinutes} min before`)}</dd></div> : null}
          </dl>
          {t.description ? <p className="ws-desc">{t.description}</p> : null}

          {actions.includes("snooze") && t.assigneeId ? <SnoozeRow id={id} onDone={(m) => { setOk(m); reload(); }} /> : null}

          <section aria-labelledby="ws-check">
            <h3 id="ws-check" className="hr-section">{L("قائمة التحقق", "Checklist")}</h3>
            {data!.checklist.length === 0 ? <p className="hr-caption">{L("لا بنود.", "No items.")}</p> : (
              <ul className="ws-check">
                {data!.checklist.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input type="checkbox" checked={!!c.doneAt} disabled={!actions.includes("checklist") || !!busy}
                        onChange={(e) => void act(`c:${c.id}`, () => wsFetch(`/api/workspace/tasks/${id}/checklist`, { json: { toggle: c.id, done: e.target.checked } }), L("حُفظ البند.", "Saved."))} />
                      <span className={c.doneAt ? "is-done" : undefined}>{c.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {actions.includes("checklist") ? (
              <form className="ws-inline" onSubmit={(e) => { e.preventDefault(); if (newItem.trim()) void act("add", () => wsFetch(`/api/workspace/tasks/${id}/checklist`, { json: { add: newItem } }), L("أُضيف البند.", "Item added.")).then((k) => k && setNewItem("")); }}>
                <input className="hr-input" value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder={L("بند جديد", "New item")} aria-label={L("بند جديد", "New item")} maxLength={300} />
                <Btn size="sm" type="submit" disabled={!newItem.trim()}>{L("إضافة", "Add")}</Btn>
              </form>
            ) : null}
          </section>

          <section aria-labelledby="ws-files">
            <h3 id="ws-files" className="hr-section">{L("المرفقات", "Attachments")}</h3>
            {(atts.data ?? []).length === 0 ? <p className="hr-caption">{L("لا مرفقات.", "No attachments.")}</p> : (
              <ul className="ws-files">
                {atts.data!.map((a) => <li key={a.id}><a href={`/api/workspace/tasks/${id}/attachments/${a.id}`} download>{a.fileName}</a> <span className="hr-caption">· {Math.ceil(a.sizeBytes / 1024)} KB · {a.uploadedBy.name}</span></li>)}
              </ul>
            )}
            {t.status !== "DONE" && t.status !== "CANCELLED" ? (
              <label className="hr-btn is-ghost is-sm ws-upload">
                {L("إرفاق ملف (PDF أو صورة، 5 ميغابايت)", "Attach a file (PDF or image, 5 MB)")}
                <input type="file" accept="application/pdf,image/jpeg,image/png" className="hr-sr" onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const form = new FormData(); form.append("file", f);
                  void act("file", () => wsFetch(`/api/workspace/tasks/${id}/attachments`, { form }), L("أُرفق الملف.", "File attached."));
                }} />
              </label>
            ) : null}
          </section>

          <section aria-labelledby="ws-comments">
            <h3 id="ws-comments" className="hr-section">{L("التعليقات", "Comments")}</h3>
            {data!.comments.length === 0 ? <p className="hr-caption">{L("لا تعليقات بعد.", "No comments yet.")}</p> : (
              <ul className="ws-comments">
                {data!.comments.map((c) => <li key={c.id}><b>{c.author.name}</b> <span className="hr-caption">{dueLabel(c.createdAt, lang, now)}</span><p>{c.body}</p></li>)}
              </ul>
            )}
            <form className="ws-inline" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void act("comment", () => wsFetch(`/api/workspace/tasks/${id}/comments`, { json: { body: comment } }), L("أُضيف التعليق.", "Comment added.")).then((k) => k && setComment("")); }}>
              <textarea className="hr-input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={L("اكتب تعليقًا", "Write a comment")} aria-label={L("تعليق", "Comment")} maxLength={4000} />
              <Btn size="sm" type="submit" busy={busy === "comment"} disabled={!comment.trim()}>{L("إرسال", "Send")}</Btn>
            </form>
          </section>

          <details className="ws-history">
            <summary>{L("السجل", "History")}</summary>
            <ol>
              {data!.history.map((h) => (
                <li key={h.id}><span>{L(...(HISTORY_LABEL[h.action] ?? [h.action, h.action]))}</span> · <span className="hr-caption">{h.actorName ?? L("النظام", "System")} · {dueLabel(h.at, lang, now)}</span>
                  {h.action === "DUE_CHANGED" && (h.data as { dueAt?: { from: string; to: string } }).dueAt ? <span className="hr-caption"> · {dueLabel((h.data as { dueAt: { from: string } }).dueAt.from, lang, now)} ← {dueLabel((h.data as { dueAt: { to: string } }).dueAt.to, lang, now)}</span> : null}
                  {typeof h.data.reason === "string" ? <span className="hr-caption"> · {h.data.reason}</span> : null}
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}

      {reason && t ? <ReasonDialog kind={reason} onClose={() => setReason(null)} onSubmit={async (text) => { const k = await transition(reason, { reason: text }); if (k) setReason(null); }} busy={busy === reason} /> : null}
      {result && t ? <ResultDialog task={t} onClose={() => setResult(false)} onDone={(m) => { setResult(false); setOk(m); reload(); onChanged(m); }} /> : null}
      {editing && t ? <EditTaskDialog task={t} onClose={() => setEditing(false)} onDone={(m) => { setEditing(false); setOk(m); reload(); onChanged(m); }} /> : null}
      {reassign && t ? <ReassignDialog task={t} onClose={() => setReassign(false)} onDone={(m) => { setReassign(false); setOk(m); reload(); onChanged(m); }} /> : null}
    </OpsPane>
  );
}

function SnoozeRow({ id, onDone }: { id: string; onDone: (m: string) => void }) {
  const L = useL();
  const [err, setErr] = useState<string | null>(null);
  const snooze = async (minutes: number) => {
    setErr(null);
    try {
      await wsFetch(`/api/workspace/tasks/${id}/snooze`, { json: { minutes } });
      onDone(L("سنذكّرك لاحقًا. الموعد النهائي لم يتغير.", "We will remind you later. The deadline did not change."));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="ws-snooze">
      <span className="hr-caption">{L("ذكّرني بعد:", "Remind me in:")}</span>
      {[[30, "30 دقيقة", "30 min"], [60, "ساعة", "1 h"], [240, "4 ساعات", "4 h"], [1440, "يوم", "1 day"]].map(([m, a, e]) => (
        <button key={m as number} type="button" className="hr-btn is-ghost is-sm" onClick={() => void snooze(m as number)}>{L(a as string, e as string)}</button>
      ))}
      {err ? <span className="hr-err">{err}</span> : null}
    </div>
  );
}

function ReasonDialog({ kind, onClose, onSubmit, busy }: { kind: "hold" | "cancel" | "return"; onClose: () => void; onSubmit: (t: string) => void; busy: boolean }) {
  const L = useL();
  const [text, setText] = useState("");
  const words = { hold: [L("إيقاف المهمة مؤقتًا", "Put the task on hold"), L("سبب التوقف", "Why is it on hold?"), L("إيقاف مؤقت", "Put on hold")], cancel: [L("إلغاء المهمة", "Cancel the task"), L("سبب الإلغاء", "Why cancel it?"), L("إلغاء المهمة", "Cancel task")], return: [L("إعادة للتنفيذ", "Return for more work"), L("ما الذي يلزم إكماله؟", "What still needs doing?"), L("إعادة للتنفيذ", "Return")] }[kind];
  return (
    <Dialog open title={words[0]} onClose={onClose} actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant={kind === "cancel" ? "danger" : "primary"} busy={busy} disabled={!text.trim()} onClick={() => onSubmit(text)}>{words[2]}</Btn>
    </>}>
      {kind === "hold" ? <p className="hr-caption">{L("التوقف لا يوقف احتساب المهلة؛ تبقى المهمة متأخرة إن تجاوزت موعدها.", "Being on hold does not stop the clock; the task is still late if it passes its deadline.")}</p> : null}
      <Field label={words[1]}><textarea className="hr-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} required /></Field>
    </Dialog>
  );
}

export function ResultDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: (m: string) => void }) {
  return (
    <RecordResultDialog sub={recordOf(task) ?? undefined} defaultChannel={task.channel ?? "CALL"} leadId={task.leadId} onClose={onClose} onDone={onDone}
      submit={(r) => wsFetch(`/api/workspace/tasks/${task.id}/result`, { json: { version: task.version, outcome: r.outcome, note: r.note, ...(r.next ? { next: { dueAt: r.next.dueAt, channel: r.next.channel } } : {}) } })} />
  );
}

/** «تسجيل النتيجة» on a planned CRM follow-up (a call, a visit, a sample's evaluation) — the same dialog. */
export function CrmResultDialog({ crm, onClose, onDone }: { crm: CrmDue; onClose: () => void; onDone: (m: string) => void }) {
  return (
    <RecordResultDialog sub={[crm.record, crm.subject].filter(Boolean).join(" · ")} defaultChannel={["VISIT", "MEETING"].includes(crm.type) ? crm.type : "CALL"} leadId={crm.leadId} onClose={onClose} onDone={onDone}
      submit={(r) => wsFetch(`/api/sales/activities/${crm.id}/result`, { json: { outcome: r.outcome, note: r.note, ...(r.next ? { next: { dueAt: r.next.dueAt, channel: r.next.channel } } : {}) } })} />
  );
}

/** «yyyy-mm-ddT10:00» Riyadh, n days from now — the proposed time of a next step. */
function tenOClockIn(days: number): string {
  return toRiyadhLocal(new Date(Date.now() + days * 86_400_000)).slice(0, 11) + "10:00";
}

/** «تسجيل اتصال» with a customer due to reorder: the call and its next step, one request (customer activities). */
export function ReorderCallDialog({ item, onClose, onDone }: { item: ReorderDue; onClose: () => void; onDone: (m: string) => void }) {
  const L = useL();
  const subject = L(`اتصال إعادة طلب · ${item.name}`, `Reorder call · ${item.nameEn}`);
  return (
    <RecordResultDialog sub={item.name} defaultChannel="CALL" onClose={onClose} onDone={onDone}
      submit={(r) => wsFetch(`/api/customers/${item.customerId}/activities`, { json: { type: "CALL", subject, body: r.note, outcome: r.outcome, completed: true, ...(r.next ? { next: { dueAt: r.next.dueAt, channel: r.next.channel } } : {}) } })} />
  );
}

type ResultInput = { outcome: string; note: string; next: { dueAt: string; channel: string } | null };

/**
 * One tap for what happened, then — when the outcome calls for one — the next step already proposed
 * (services/sales/follow-through.ts suggestNextStep: «لم يرد» → call again tomorrow, «تم الاتفاق على
 * اجتماع» → the meeting in two days …). The rep confirms or changes it; nothing longer is asked.
 */
type ResultResponse = { activityId?: string | null; qualification?: { converted?: boolean; missing?: string[] } | null };

function RecordResultDialog({ sub, defaultChannel, leadId, submit, onClose, onDone }: {
  sub?: string; defaultChannel: string; leadId?: string | null; submit: (r: ResultInput) => Promise<unknown>; onClose: () => void; onDone: (m: string) => void;
}) {
  const L = useL();
  const lang = useLang();
  // A qualifying outcome on a lead converts only with the minimum known (services/sales/needs.ts):
  // when the server says what is missing, the same dialog asks for it and completes that activity.
  const [qualify, setQualify] = useState<{ activityId: string; missing: string[]; saved: string } | null>(null);
  const [draft, setDraft] = useState<QualificationDraft>(EMPTY_QUALIFICATION);
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const [next, setNext] = useState(false);
  const [nextAt, setNextAt] = useState(() => toRiyadhLocal(new Date(Date.now() + 2 * 86_400_000)).slice(0, 11) + "10:00");
  const [channel, setChannel] = useState(defaultChannel);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const choose = (v: string) => {
    setOutcome(v);
    const s = suggestNextStep(v);
    setNext(!!s);
    if (s) {
      setChannel(s.channel);
      setNextAt(tenOClockIn(s.inDays));
    }
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const at = parseRiyadhLocal(nextAt);
      if (next && !at) throw new Error(L("موعد الخطوة التالية غير صالح.", "The next step's time is not valid."));
      const res = (await submit({ outcome, note, next: next ? { dueAt: at!.toISOString(), channel } : null })) as ResultResponse | null;
      const saved = next ? L("سُجلت النتيجة في سجل العميل وأُنشئت الخطوة التالية.", "Result saved to the customer timeline; next step created.") : L("سُجلت النتيجة في سجل العميل.", "Result saved to the customer timeline.");
      if (leadId && res?.activityId && res.qualification && res.qualification.converted === false && res.qualification.missing?.length) {
        setQualify({ activityId: res.activityId, missing: res.qualification.missing, saved });
        return;
      }
      onDone(saved);
    } catch (e) { setErr(messageOf(e, L)); } finally { setBusy(false); }
  };
  const saveQualification = async () => {
    if (!qualify || !leadId) return;
    setBusy(true); setErr(null);
    try {
      await wsFetch(`/api/sales/leads/${leadId}/qualify`, { json: { activityId: qualify.activityId, qualification: qualificationPayload(draft) } });
      onDone(L("سُجلت النتيجة وتحوّل العميل المحتمل إلى فرصة مؤهلة.", "Result saved; the lead is now a qualified opportunity."));
    } catch (e) { setErr(messageOf(e, L)); } finally { setBusy(false); }
  };
  if (qualify) {
    return (
      <Dialog open title={L("استكمال التأهيل", "Complete the qualification")} sub={sub} onClose={() => onDone(qualify.saved)} testId="qualify-dialog" actions={<>
        <Btn onClick={() => onDone(qualify.saved)}>{L("لاحقًا", "Later")}</Btn>
        <Btn variant="primary" busy={busy} onClick={() => void saveQualification()} data-testid="qualify-save">{L("تحويل إلى فرصة", "Make it an opportunity")}</Btn>
      </>}>
        <Notice tone="info">{qualify.saved} {missingText(qualify.missing, lang === "ar")}</Notice>
        {err ? <Notice tone="danger">{err}</Notice> : null}
        <QualificationFields ar={lang === "ar"} value={draft} onChange={setDraft} missing={qualify.missing} idPrefix="ws-qual" />
      </Dialog>
    );
  }
  return (
    <Dialog open title={L("تسجيل النتيجة", "Record the result")} sub={sub} onClose={onClose} testId="result-dialog" actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant="primary" busy={busy} disabled={!outcome} onClick={() => void save()} data-testid="result-save">{L("حفظ النتيجة", "Save result")}</Btn>
    </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <fieldset className="ws-choices">
        <legend className="hr-label">{L("ماذا حدث؟", "What happened?")}</legend>
        {OUTCOMES.map(([v, a, e]) => (
          <label key={v} className={`ws-choice${outcome === v ? " is-on" : ""}`}><input type="radio" name="outcome" value={v} checked={outcome === v} onChange={() => choose(v)} /> {L(a, e)}</label>
        ))}
      </fieldset>
      <Field label={L("ملاحظة (اختيارية، تظهر في سجل العميل)", "Note (optional, shown on the customer timeline)")}><textarea className="hr-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
      <label className="ws-check-line"><input type="checkbox" checked={next} onChange={(e) => setNext(e.target.checked)} /> {L("تحديد الخطوة التالية", "Set the next step")}</label>
      {next ? (
        <div className="ws-row2">
          <Field label={L("الموعد", "When")}><input type="datetime-local" className="hr-input" value={nextAt} onChange={(e) => setNextAt(e.target.value)} /></Field>
          <Field label={L("الطريقة", "How")}><Select className="hr-select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="CALL">{L("اتصال", "Call")}</option><option value="VISIT">{L("زيارة", "Visit")}</option><option value="MEETING">{L("اجتماع", "Meeting")}</option>
          </Select></Field>
        </div>
      ) : null}
    </Dialog>
  );
}

function ReassignDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: (m: string) => void }) {
  const L = useL();
  const people = usePeople("assign");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await wsFetch(`/api/workspace/tasks/${task.id}/reassign`, { json: { assigneeId: to, version: task.version, note } });
      onDone(L("أُعيد إسناد المهمة وأُبلغ المسؤول الجديد.", "Reassigned; the new owner was told."));
    } catch (e) { setErr(messageOf(e, L)); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={L("إعادة إسناد المهمة", "Reassign the task")} onClose={onClose} actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant="primary" busy={busy} disabled={!to} onClick={() => void save()}>{L("إعادة الإسناد", "Reassign")}</Btn>
    </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <Field label={L("المسؤول الجديد", "New owner")}><Select className="hr-select" value={to} onChange={(e) => setTo(e.target.value)} placeholder={L("اختر موظفًا", "Choose a colleague")}>
        <option value="">—</option>
        {people.filter((p) => p.id !== task.assigneeId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select></Field>
      <Field label={L("ملاحظة (اختيارية)", "Note (optional)")}><input className="hr-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
    </Dialog>
  );
}

/** What was asked: title, deadline (recorded in the history; the reminders follow), priority, reminder. */
function EditTaskDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: (m: string) => void }) {
  const L = useL();
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(toRiyadhLocal(new Date(task.dueAt)));
  const [priority, setPriority] = useState<string>(task.priority);
  const [remind, setRemind] = useState(task.remindBeforeMinutes === null ? "" : String(task.remindBeforeMinutes));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const at = parseRiyadhLocal(due);
      if (!at) throw new Error(L("الموعد غير صالح.", "The deadline is not valid."));
      const body: Record<string, unknown> = { version: task.version };
      if (title.trim() !== task.title) body.title = title;
      if (at.getTime() !== new Date(task.dueAt).getTime()) body.dueAt = at.toISOString();
      if (priority !== task.priority) body.priority = priority;
      const r = remind === "" ? null : Number(remind);
      if (r !== task.remindBeforeMinutes) body.remindBeforeMinutes = r;
      await wsFetch(`/api/workspace/tasks/${task.id}`, { method: "PATCH", json: body });
      onDone(body.dueAt ? L("تغيّر الموعد وسُجل في السجل، وأُبلغ المسؤول.", "Deadline changed, recorded and the owner told.") : L("حُفظت التعديلات.", "Saved."));
    } catch (e) { setErr(messageOf(e, L)); } finally { setBusy(false); }
  };
  return (
    <Dialog open title={L("تعديل المهمة", "Edit task")} onClose={onClose} actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant="primary" busy={busy} disabled={!title.trim()} onClick={() => void save()} data-testid="task-edit-save">{L("حفظ التعديلات", "Save changes")}</Btn>
    </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <Field label={L("العنوان", "Title")}><input className="hr-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></Field>
      <div className="ws-row2">
        <Field label={L("الموعد النهائي (بتوقيت الرياض)", "Deadline (Riyadh)")} help={L("يُسجل التغيير في سجل المهمة.", "The change is recorded in the history.")}><input type="datetime-local" className="hr-input" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label={L("الأولوية", "Priority")}><Select className="hr-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{L(PRIORITY_LABEL[p].ar, PRIORITY_LABEL[p].en)}</option>)}
        </Select></Field>
      </div>
      <Field label={L("التذكير قبل الموعد", "Reminder before the deadline")}><Select className="hr-select" value={remind} onChange={(e) => setRemind(e.target.value)}>
        <option value="">{L("بلا تذكير", "None")}</option><option value="30">{L("30 دقيقة", "30 min")}</option><option value="60">{L("ساعة", "1 h")}</option><option value="120">{L("ساعتان", "2 h")}</option><option value="1440">{L("يوم", "1 day")}</option>
      </Select></Field>
    </Dialog>
  );
}

export function usePeople(purpose: "assign" | "invite") {
  const { data } = useWs<{ items: { id: string; name: string; self: boolean }[] }>(`/api/workspace/people?purpose=${purpose}`);
  return data?.items ?? [];
}

type Link = { type: "customer" | "lead" | "deal"; id: string; label: string };

/** Search customers / leads / deals the caller may see. */
export function LinkPicker({ value, onChange }: { value: Link | null; onChange: (l: Link | null) => void }) {
  const L = useL();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ q: string; items: Link[] }>({ q: "", items: [] });
  useEffect(() => {
    if (q.trim().length < 2) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/workspace/links?q=${encodeURIComponent(q)}`, { signal: c.signal }).then((r) => (r.ok ? r.json() : { items: [] })).then((b) => setFound({ q, items: b.items ?? [] })).catch(() => undefined);
    }, 250);
    return () => { clearTimeout(t); c.abort(); };
  }, [q]);
  const items = q.trim().length >= 2 && found.q === q ? found.items : [];
  const kind = (k: string) => ({ customer: L("عميل", "Customer"), lead: L("عميل محتمل", "Lead"), deal: L("صفقة", "Deal") }[k] ?? k);
  if (value) return <div className="ws-picked"><span>{kind(value.type)}: <b>{value.label}</b></span> <button type="button" className="hr-btn is-ghost is-sm" onClick={() => onChange(null)}>{L("تغيير", "Change")}</button></div>;
  return (
    <div className="ws-search">
      <input className="hr-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("ابحث باسم العميل أو الصفقة", "Search a customer or deal")} aria-label={L("الربط بعميل أو صفقة", "Link to a customer or deal")} />
      {items.length ? <ul role="listbox" className="ws-options">{items.map((i) => <li key={`${i.type}:${i.id}`}><button type="button" onClick={() => { onChange(i); setQ(""); }}>{kind(i.type)} · {i.label}</button></li>)}</ul> : null}
    </div>
  );
}

const QUICK: [string, string, string][] = [["h4", "خلال 4 ساعات", "In 4 hours"], ["h5", "خلال 5 ساعات", "In 5 hours"], ["eod", "نهاية اليوم", "End of day"], ["tomorrow", "غدًا", "Tomorrow"], ["exact", "تاريخ ووقت…", "Date & time…"]];

/** Create a task. The deadline actually computed is shown before saving (POST /api/workspace/due-preview). */
export function CreateTaskDialog({ onClose, onCreated, preset }: { onClose: () => void; onCreated: (t: Task, msg: string) => void; preset?: { kind?: "FOLLOW_UP"; link?: Link | null } }) {
  const L = useL();
  const lang = useLang();
  const people = usePeople("assign");
  const invitees = usePeople("invite");
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [quick, setQuick] = useState("h4");
  const [business, setBusiness] = useState(false);
  const [exact, setExact] = useState(() => toRiyadhLocal(new Date(Date.now() + 3_600_000)).slice(0, 14) + "00");
  const [priority, setPriority] = useState("NORMAL");
  const [more, setMore] = useState(!!preset?.kind);
  const [kind, setKind] = useState<"TASK" | "FOLLOW_UP">(preset?.kind ?? "TASK");
  const [channel, setChannel] = useState("CALL");
  const [link, setLink] = useState<Link | null>(preset?.link ?? null);
  const [description, setDescription] = useState("");
  const [checklist, setChecklist] = useState("");
  const [review, setReview] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const [watchers, setWatchers] = useState<string[]>([]);
  const [recur, setRecur] = useState("");
  const [previewOf, setPreviewOf] = useState<{ key: string; dueAt: string | null }>({ key: "", dueAt: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const self = people.find((p) => p.self);
  const owner = assigneeId || self?.id || "";

  const due = useMemo(() => {
    if (quick === "exact") { const at = parseRiyadhLocal(exact); return at ? { dueAt: at.toISOString() } : null; }
    return { due: { quick, basis: business ? "BUSINESS" : "CLOCK" } };
  }, [quick, business, exact]);
  const dueKey = JSON.stringify(due);
  useEffect(() => {
    if (!due) return;
    let alive = true;
    wsFetch<{ dueAt: string }>("/api/workspace/due-preview", { json: due })
      .then((p) => { if (alive) setPreviewOf({ key: dueKey, dueAt: p.dueAt }); })
      .catch(() => { if (alive) setPreviewOf({ key: dueKey, dueAt: null }); });
    return () => { alive = false; };
  }, [due, dueKey]);
  const preview = due && previewOf.key === dueKey && previewOf.dueAt ? { dueAt: previewOf.dueAt } : null;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!due) throw new Error(L("حدّد الموعد النهائي.", "Choose a deadline."));
      const body = {
        title, assigneeId: owner || undefined, priority, ...due, kind,
        ...(kind === "FOLLOW_UP" ? { channel } : {}),
        ...(link ? { [link.type === "customer" ? "customerId" : link.type === "lead" ? "leadId" : "opportunityId"]: link.id } : {}),
        ...(description.trim() ? { description } : {}),
        ...(checklist.trim() ? { checklist: checklist.split("\n").map((x) => x.trim()).filter(Boolean) } : {}),
        ...(review ? { requiresReview: true, reviewerId: reviewerId || undefined } : {}),
        ...(watchers.length ? { watcherIds: watchers } : {}),
        ...(recur ? { recurRule: recur, recurInterval: 1 } : {}),
      };
      const t = await wsFetch<Task>("/api/workspace/tasks", { json: body });
      onCreated(t, owner && owner !== self?.id ? L(`أُسندت المهمة إلى ${t.assignee.name} وأُبلغ.`, `Assigned to ${t.assignee.name}; they were told.`) : L("أُنشئت المهمة.", "Task created."));
    } catch (e) { setErr(messageOf(e, L)); } finally { setBusy(false); }
  };

  return (
    <Dialog open title={kind === "FOLLOW_UP" ? L("متابعة عميل جديدة", "New customer follow-up") : L("مهمة جديدة", "New task")} onClose={onClose} testId="create-task" className="ws-dialog" actions={<>
      <Btn onClick={onClose}>{L("تراجع", "Back")}</Btn>
      <Btn variant="primary" busy={busy} disabled={!title.trim() || !due || (kind === "FOLLOW_UP" && !link)} onClick={() => void save()} data-testid="create-task-save">{L("إنشاء المهمة", "Create task")}</Btn>
    </>}>
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <Field label={L("عنوان المهمة", "Title")}><input className="hr-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required data-testid="task-title" /></Field>
      <div className="ws-row2">
        <Field label={L("المسؤول", "Owner")}><Select className="hr-select" value={owner} onChange={(e) => setAssigneeId(e.target.value)}>
          {people.map((p) => <option key={p.id} value={p.id}>{p.self ? L(`أنا (${p.name})`, `Me (${p.name})`) : p.name}</option>)}
        </Select></Field>
        <Field label={L("الأولوية", "Priority")}><Select className="hr-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{L(PRIORITY_LABEL[p].ar, PRIORITY_LABEL[p].en)}</option>)}
        </Select></Field>
      </div>
      <fieldset className="ws-choices">
        <legend className="hr-label">{L("الموعد النهائي", "Deadline")}</legend>
        {QUICK.map(([v, a, e]) => <label key={v} className={`ws-choice${quick === v ? " is-on" : ""}`}><input type="radio" name="quick" value={v} checked={quick === v} onChange={() => setQuick(v)} /> {L(a, e)}</label>)}
      </fieldset>
      {quick === "exact" ? (
        <Field label={L("التاريخ والوقت (بتوقيت الرياض)", "Date and time (Riyadh)")}><input type="datetime-local" className="hr-input" value={exact} onChange={(e) => setExact(e.target.value)} /></Field>
      ) : (
        <label className="ws-check-line"><input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} /> {L("احسب بساعات الدوام", "Count working hours only")}</label>
      )}
      <p className="ws-due-preview" aria-live="polite" data-testid="due-preview">{preview ? <>{L("يُستحق: ", "Due: ")}<b>{dueLabel(preview.dueAt, lang)}</b></> : L("اختر موعدًا صالحًا في المستقبل.", "Choose a valid future time.")}</p>

      <button type="button" className="ws-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>{more ? "▾" : "▸"} {L("خيارات إضافية", "More options")}</button>
      {more ? (
        <div className="hr-stack">
          <div className="ws-row2">
            <Field label={L("النوع", "Type")}><Select className="hr-select" value={kind} onChange={(e) => setKind(e.target.value as "TASK" | "FOLLOW_UP")}>
              <option value="TASK">{L("مهمة", "Task")}</option><option value="FOLLOW_UP">{L("متابعة عميل", "Customer follow-up")}</option>
            </Select></Field>
            {kind === "FOLLOW_UP" ? <Field label={L("طريقة المتابعة", "How")}><Select className="hr-select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="CALL">{L("اتصال", "Call")}</option><option value="VISIT">{L("زيارة", "Visit")}</option><option value="MEETING">{L("اجتماع", "Meeting")}</option>
            </Select></Field> : null}
          </div>
          <Field label={kind === "FOLLOW_UP" ? L("العميل أو الصفقة (مطلوب)", "Customer or deal (required)") : L("مرتبطة بعميل أو صفقة", "Linked customer or deal")}><LinkPicker value={link} onChange={setLink} /></Field>
          <Field label={L("الوصف", "Description")}><textarea className="hr-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></Field>
          <Field label={L("قائمة تحقق (بند في كل سطر)", "Checklist (one item per line)")}><textarea className="hr-input" rows={3} value={checklist} onChange={(e) => setChecklist(e.target.value)} /></Field>
          <label className="ws-check-line"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> {L("تحتاج مراجعة بعد الإنجاز", "Needs a review when done")}</label>
          {review ? <Field label={L("المراجع (اختياري — وإلا أنت)", "Reviewer (optional — otherwise you)")}><Select className="hr-select" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
            <option value="">{L("أنا", "Me")}</option>
            {invitees.filter((p) => !p.self && p.id !== owner).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select></Field> : null}
          <Field label={L("المتابعون", "Watchers")}>
            <div className="ws-watchers">{invitees.filter((p) => !p.self && p.id !== owner).slice(0, 30).map((p) => (
              <label key={p.id} className={`ws-choice${watchers.includes(p.id) ? " is-on" : ""}`}><input type="checkbox" checked={watchers.includes(p.id)} onChange={(e) => setWatchers((w) => (e.target.checked ? [...w, p.id] : w.filter((x) => x !== p.id)))} /> {p.name}</label>
            ))}</div>
          </Field>
          <Field label={L("التكرار", "Repeat")}><Select className="hr-select" value={recur} onChange={(e) => setRecur(e.target.value)}>
            <option value="">{L("لا يتكرر", "Does not repeat")}</option><option value="DAILY">{L("يوميًا", "Daily")}</option><option value="WEEKLY">{L("أسبوعيًا", "Weekly")}</option><option value="MONTHLY">{L("شهريًا", "Monthly")}</option>
          </Select></Field>
        </div>
      ) : null}
    </Dialog>
  );
}
