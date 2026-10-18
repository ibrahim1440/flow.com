"use client";
// HR-02 · Performance: trainings, reviews and incidents (performance_manage).
import { useCallback, useState } from "react";
import { Btn, Dialog, Empty, ErrorState, Field, LoadingTable, Notice, StatusDot, statusLabel, todayIso, useAction, useForm, useHr, useHrI18n } from "@/components/hr/ui";
import { Check, INCIDENT_CATEGORY, REVIEW_STATUS, SectionHead, TRAINING_STATUS, fmtDateTime, lbl, mutate, type TabProps } from "./shared";

type Training = { id: string; title: string; provider: string | null; startDate: string; endDate: string | null; status: string; notes: string | null };
type Review = { id: string; periodLabel: string; rating: number; strengths: string | null; improvements: string | null; status: string; createdAt: string; submittedAt: string | null; acknowledgedAt: string | null };
type Incident = { id: string; occurredOn: string; category: string; description: string; actionTaken: string | null; confidential: boolean; createdAt: string };
type Perf = { trainings: Training[]; reviews: Review[]; incidents: Incident[] };
type Kind = "training" | "review" | "incident";

export default function PerformanceTab({ id, readOnly }: TabProps) {
  const { data, error, loading, reload } = useHr<Perf>(`/api/hr/employees/${id}/performance`);
  const [dlg, setDlg] = useState<Kind | null>(null);
  const close = useCallback(() => setDlg(null), []);
  const done = useCallback(() => { setDlg(null); void reload(); }, [reload]);
  const { L, t, lang } = useHrI18n();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <LoadingTable />;
  if (!data) return null;
  const add = (k: Kind, label: string) => (readOnly ? null : <Btn size="sm" onClick={() => setDlg(k)}>{label}</Btn>);
  return (
    <div className="hr-stack" style={{ gap: 28 }}>
      <section className="hr-stack">
        <SectionHead title={L("تقييمات الأداء", "Performance reviews")} actions={add("review", L("تقييم جديد", "New review"))} />
        {data.reviews.length === 0 ? <Empty title={L("لا توجد تقييمات", "No reviews")} /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("تقييمات الأداء", "Performance reviews")}>
              <thead><tr><th>{L("الفترة", "Period")}</th><th className="num">{L("التقييم", "Rating")}</th><th>{L("نقاط القوة", "Strengths")}</th><th>{L("مجالات التحسين", "Areas to improve")}</th><th>{t("status")}</th></tr></thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id}>
                    <td data-label={L("الفترة", "Period")} className="strong">{r.periodLabel}<span className="sub"><span className="hr-num">{fmtDateTime(r.submittedAt ?? r.createdAt).slice(0, 10)}</span></span></td>
                    <td data-label={L("التقييم", "Rating")} className="num">{r.rating} / 5</td>
                    <td data-label={L("نقاط القوة", "Strengths")} className="hr-muted">{r.strengths ?? "—"}</td>
                    <td data-label={L("مجالات التحسين", "Areas to improve")} className="hr-muted">{r.improvements ?? "—"}</td>
                    <td data-label={t("status")}><StatusDot map={REVIEW_STATUS} value={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="hr-stack">
        <SectionHead title={L("التدريب", "Training")} actions={add("training", L("إضافة تدريب", "Add training"))} />
        {data.trainings.length === 0 ? <Empty title={L("لا يوجد تدريب مسجل", "No training recorded")} /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("التدريب", "Training")}>
              <thead><tr><th>{L("البرنامج", "Programme")}</th><th>{L("الجهة", "Provider")}</th><th className="num">{t("from")}</th><th className="num">{t("to")}</th><th>{t("status")}</th></tr></thead>
              <tbody>
                {data.trainings.map((x) => (
                  <tr key={x.id}>
                    <td data-label={L("البرنامج", "Programme")} className="strong">{x.title}{x.notes ? <span className="sub">{x.notes}</span> : null}</td>
                    <td data-label={L("الجهة", "Provider")} className="hr-muted">{x.provider ?? "—"}</td>
                    <td data-label={t("from")} className="num">{x.startDate}</td>
                    <td data-label={t("to")} className="num">{x.endDate ?? "—"}</td>
                    <td data-label={t("status")}><StatusDot map={TRAINING_STATUS} value={x.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="hr-stack">
        <SectionHead title={L("المخالفات والإنذارات", "Incidents and warnings")} actions={add("incident", L("تسجيل مخالفة", "Record incident"))} />
        {data.incidents.length === 0 ? <Empty title={L("لا توجد مخالفات مسجلة", "No incidents recorded")} /> : (
          <div className="hr-tablewrap">
            <table className="hr-table is-stack" aria-label={L("المخالفات", "Incidents")}>
              <thead><tr><th className="num">{t("date")}</th><th>{L("الفئة", "Category")}</th><th>{L("الوصف", "Description")}</th><th>{L("الإجراء المتخذ", "Action taken")}</th></tr></thead>
              <tbody>
                {data.incidents.map((i) => (
                  <tr key={i.id}>
                    <td data-label={t("date")} className="num">{i.occurredOn}</td>
                    <td data-label={L("الفئة", "Category")}>{lbl(INCIDENT_CATEGORY, i.category, lang)}{i.confidential ? <span className="sub">{L("سري", "Confidential")}</span> : null}</td>
                    <td data-label={L("الوصف", "Description")}>{i.description}</td>
                    <td data-label={L("الإجراء المتخذ", "Action taken")} className="hr-muted">{i.actionTaken ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dlg === "training" ? <TrainingDialog id={id} onClose={close} onDone={done} /> : null}
      {dlg === "review" ? <ReviewDialog id={id} onClose={close} onDone={done} /> : null}
      {dlg === "incident" ? <IncidentDialog id={id} onClose={close} onDone={done} /> : null}
    </div>
  );
}

type DlgProps = { id: string; onClose: () => void; onDone: () => void };

function TrainingDialog({ id, onClose, onDone }: DlgProps) {
  const f = useForm({ title: "", provider: "", startDate: todayIso(), endDate: "", status: "PLANNED", notes: "" });
  const a = useAction();
  const { L, t, lang } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/trainings`, { json: Object.fromEntries(Object.entries(f.v).filter(([, v]) => v !== "")) });
    onDone();
  });
  return (
    <Dialog open title={L("إضافة تدريب", "Add training")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.title.trim() || !f.v.startDate}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("البرنامج *", "Programme *")} wide><input className="hr-input" {...f.bind("title")} /></Field>
        <Field label={L("الجهة المقدمة", "Provider")}><input className="hr-input" {...f.bind("provider")} /></Field>
        <Field label={t("status")}><select className="hr-select" {...f.bind("status")}>{Object.keys(TRAINING_STATUS).map((k) => <option key={k} value={k}>{statusLabel(TRAINING_STATUS, k, lang)}</option>)}</select></Field>
        <Field label={L("من *", "From *")}><input className="hr-input" type="date" {...f.bind("startDate")} /></Field>
        <Field label={t("to")}><input className="hr-input" type="date" {...f.bind("endDate")} /></Field>
        <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-textarea" {...f.bind("notes")} /></Field>
      </div>
    </Dialog>
  );
}

function ReviewDialog({ id, onClose, onDone }: DlgProps) {
  const f = useForm({ periodLabel: "", rating: "3", strengths: "", improvements: "" });
  const a = useAction();
  const { L, t } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/reviews`, { json: { ...f.v, rating: Number(f.v.rating), strengths: f.v.strengths || undefined, improvements: f.v.improvements || undefined } });
    onDone();
  });
  return (
    <Dialog open title={L("تقييم أداء جديد", "New performance review")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.periodLabel.trim()}>{L("إرسال التقييم", "Submit review")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الفترة *", "Period *")} help={L("مثال: 2026-H1", "e.g. 2026-H1")}><input className="hr-input" {...f.bind("periodLabel")} /></Field>
        <Field label={L("التقييم (1–5) *", "Rating (1–5) *")}>
          <select className="hr-select" {...f.bind("rating")}>
            {[["5", L("5 · ممتاز", "5 · Excellent")], ["4", L("4 · جيد جدًا", "4 · Very good")], ["3", L("3 · جيد", "3 · Good")], ["2", L("2 · يحتاج تحسينًا", "2 · Needs improvement")], ["1", L("1 · غير مرضٍ", "1 · Unsatisfactory")]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label={L("نقاط القوة", "Strengths")} wide><textarea className="hr-textarea" {...f.bind("strengths")} /></Field>
        <Field label={L("مجالات التحسين", "Areas to improve")} wide><textarea className="hr-textarea" {...f.bind("improvements")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("يُرسل التقييم باسمك ويظهر للموظف ليطّلع عليه. لا يمكنك تقييم نفسك.", "The review is submitted in your name and shown to the employee to acknowledge. You cannot review yourself.")}</p>
    </Dialog>
  );
}

function IncidentDialog({ id, onClose, onDone }: DlgProps) {
  const f = useForm({ occurredOn: todayIso(), category: "WARNING", description: "", actionTaken: "" });
  const [confidential, setConfidential] = useState(true);
  const a = useAction();
  const { L, t, lang } = useHrI18n();
  const submit = () => a.run("save", async () => {
    await mutate(`/api/hr/employees/${id}/incidents`, { json: { ...f.v, actionTaken: f.v.actionTaken || undefined, confidential } });
    onDone();
  });
  return (
    <Dialog open title={L("تسجيل مخالفة", "Record incident")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit} disabled={!f.v.occurredOn || f.v.description.trim().length < 5}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("التاريخ *", "Date *")}><input className="hr-input" type="date" {...f.bind("occurredOn")} /></Field>
        <Field label={L("الفئة *", "Category *")}><select className="hr-select" {...f.bind("category")}>{Object.keys(INCIDENT_CATEGORY).map((k) => <option key={k} value={k}>{lbl(INCIDENT_CATEGORY, k, lang)}</option>)}</select></Field>
        <Field label={L("الوصف *", "Description *")} help={L("خمسة أحرف على الأقل", "At least five characters")} wide><textarea className="hr-textarea" {...f.bind("description")} /></Field>
        <Field label={L("الإجراء المتخذ", "Action taken")} wide><input className="hr-input" {...f.bind("actionTaken")} /></Field>
      </div>
      <Check checked={confidential} onChange={setConfidential}>{L("سري", "Confidential")}</Check>
    </Dialog>
  );
}
