"use client";
// HR-02 · Overview: job facts, a cross-tab summary, private data (revealed on demand and
// audited), a short document list and the person's date reminders.
import { useCallback, useState } from "react";
import { Download } from "lucide-react";
import { Btn, CONTRACT_STATUS, Dialog, Dot, Field, KV, Notice, StatusDot, hrFetch, money, useAction, useForm, useHr, useHrI18n } from "@/components/hr/ui";
import { leaveTypeName, orgName } from "@/lib/i18n/hr";
import { hrText } from "@/lib/hr/messages-en";
import { dayCount } from "../../../leave/parts";
import { CONTRACT_TYPE, DOC_CATEGORY, EMPLOYMENT_TYPE, SectionHead, fileSize, lbl, mutate, type AdvanceRow, type Balance, type TabProps } from "./shared";

const PRIVATE_FIELDS: { key: string; label: string; en: string; kind?: "date" | "ltr" }[] = [
  { key: "idType", label: "نوع الهوية", en: "ID type" },
  { key: "idNumber", label: "رقم الهوية / الإقامة", en: "ID / iqama no.", kind: "ltr" },
  { key: "idExpiry", label: "انتهاء الهوية", en: "ID expiry", kind: "date" },
  { key: "nationality", label: "الجنسية", en: "Nationality" },
  { key: "contributionGroup", label: "فئة الاشتراك (التأمينات)", en: "Contribution group (GOSI)" },
  { key: "dateOfBirth", label: "تاريخ الميلاد", en: "Date of birth", kind: "date" },
  { key: "gender", label: "الجنس", en: "Gender" },
  { key: "personalPhone", label: "الجوال الشخصي", en: "Personal mobile", kind: "ltr" },
  { key: "personalEmail", label: "البريد الشخصي", en: "Personal email", kind: "ltr" },
  { key: "address", label: "العنوان", en: "Address" },
  { key: "bankName", label: "البنك", en: "Bank" },
  { key: "iban", label: "رقم الآيبان", en: "IBAN", kind: "ltr" },
  { key: "emergencyName", label: "جهة الاتصال للطوارئ", en: "Emergency contact" },
  { key: "emergencyRelation", label: "صلة القرابة", en: "Relationship" },
  { key: "emergencyPhone", label: "هاتف الطوارئ", en: "Emergency phone", kind: "ltr" },
];
const PRIVATE_SUMMARY = ["idNumber", "idExpiry", "nationality", "dateOfBirth", "iban", "emergencyPhone"];
type Private = Record<string, string | null>;

export default function OverviewTab({ id, profile, readOnly }: TabProps) {
  const { person: p, permissions: perm, currentContract: cc, snapshot: snap } = profile;
  const leave = useHr<Balance[]>(perm.leave ? `/api/hr/employees/${id}/leave` : null);
  const adv = useHr<AdvanceRow[]>(perm.advances ? "/api/hr/advances" : null);
  const mine = adv.data?.filter((a) => a.employee.id === id) ?? [];
  const openAdv = mine.filter((a) => a.status === "DISBURSED");
  const outstanding = openAdv.reduce((s, a) => s + Number(a.outstanding), 0);
  const tracked = leave.data?.filter((b) => b.tracksBalance) ?? [];
  const openAssets = profile.assets?.filter((a) => !a.returnedOn) ?? [];
  const n = (v: string | null | undefined) => (v ? <span className="hr-num">{v}</span> : "—");
  const { L, t, lang } = useHrI18n();
  const none = L("لا توجد", "None");
  const failed = L("تعذّر التحميل", "Couldn’t load");

  return (
    <div className="hr-cols">
      <div className="hr-stack" style={{ gap: 24 }}>
        <section className="hr-stack">
          <SectionHead title={L("بيانات الوظيفة", "Job details")} />
          <div className="hr-cols-2">
            <KV rows={[
              [t("department"), p.department ? orgName(p.department, lang) : "—"],
              [L("المدير المباشر", "Line manager"), p.manager?.fullNameAr ?? "—"],
              [L("تاريخ المباشرة", "Start date"), n(p.hireDate)],
              [L("نهاية فترة التجربة", "Probation ends"), n(p.probationEndDate)],
              ...(p.separationDate ? [[L("تاريخ انتهاء الخدمة", "Service end date"), n(p.separationDate)] as [string, React.ReactNode]] : []),
            ]} />
            <KV rows={[
              [t("branch"), p.branch ? orgName(p.branch, lang) : "—"],
              [L("الوردية", "Shift"), snap?.shift ? <span key="s">{snap.shift.name} <span className="hr-num">{snap.shift.startTime}–{snap.shift.endTime}</span></span> : "—"],
              [L("حساب الدخول", "Login account"), p.hasAccount ? L("مرتبط", "Linked") : t("none"), p.hasAccount ? undefined : "muted"],
              [L("نوع التوظيف", "Employment type"), lbl(EMPLOYMENT_TYPE, p.employmentType, lang)],
              ...(p.workPhone ? [[L("هاتف العمل", "Work phone"), <span key="wp" className="hr-num">{p.workPhone}</span>] as [string, React.ReactNode]] : []),
              ...(p.workEmail ? [[L("بريد العمل", "Work email"), <span key="we" className="hr-iso" dir="ltr">{p.workEmail}</span>] as [string, React.ReactNode]] : []),
            ]} />
          </div>
        </section>

        {/* HR-02: contracts and pay on the overview — only when the server returned them (contracts duty). */}
        {profile.contracts ? (
          <section className="hr-stack" aria-labelledby="ov-contract">
            <SectionHead title={L("العقد والراتب", "Contract & salary")} id="ov-contract" actions={<span className="hr-caption">{L("صلاحية «العقود والرواتب»", "“Contracts & payroll” permission")}</span>} />
            {profile.contracts.length === 0 ? <p className="hr-caption" style={{ margin: 0 }}>{L("لا عقود مسجّلة.", "No contracts recorded.")}</p> : (
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow" aria-label={L("العقود", "Contracts")}>
                  <thead><tr><th>{L("العقد", "Contract")}</th><th>{t("type")}</th><th className="num">{t("from")}</th><th className="num">{t("to")}</th><th className="num">{L("الإشعار", "Notice")}</th><th>{t("status")}</th></tr></thead>
                  <tbody>
                    {profile.contracts.slice(0, 3).map((c) => (
                      <tr key={c.id}>
                        <td data-label={L("العقد", "Contract")} className="m-title"><span className="hr-id">{c.contractNo}</span><span className="hr-msub">{lbl(CONTRACT_TYPE, c.type, lang)} · <span className="hr-num">{c.startDate}</span> → <span className="hr-num">{c.endDate ?? "—"}</span> · {L("إشعار", "notice")} <span className="hr-num">{c.noticeDays}</span> {L("يومًا", "days")}</span></td>
                        <td data-label={t("type")}>{lbl(CONTRACT_TYPE, c.type, lang)}</td>
                        <td data-label={t("from")} className="num">{c.startDate}</td>
                        <td data-label={t("to")} className="num">{c.endDate ?? "—"}</td>
                        <td data-label={L("الإشعار", "Notice")} className="num"><span className="hr-num">{c.noticeDays}</span> {L("يومًا", "days")}</td>
                        <td data-label={t("status")} className="m-end"><StatusDot map={CONTRACT_STATUS} value={c.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {profile.compensation && profile.compensation.length ? (
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow" aria-label={L("نسخ الراتب", "Pay versions")}>
                  <thead><tr><th className="num">{L("سريان من", "Effective from")}</th><th className="num">{L("الأساسي", "Basic")}</th><th className="num">{L("السكن", "Housing")}</th><th className="num">{L("النقل", "Transport")}</th><th className="num">{L("أخرى", "Other")}</th><th className="num">{L("الإجمالي", "Total")}</th><th>{t("reason")}</th></tr></thead>
                  <tbody>
                    {profile.compensation.slice(0, 3).map((c) => (
                      <tr key={c.id}>
                        <td data-label={L("سريان من", "Effective from")} className="num m-title">{c.effectiveFrom}<span className="hr-msub">{L("الأساسي", "Basic")} <span className="hr-num">{money(c.basic)}</span> · {L("السكن", "Housing")} <span className="hr-num">{money(c.housing)}</span> · {L("النقل", "Transport")} <span className="hr-num">{money(c.transport)}</span> · {c.reason}</span></td>
                        <td data-label={L("الأساسي", "Basic")} className="num">{money(c.basic)}</td>
                        <td data-label={L("السكن", "Housing")} className="num">{money(c.housing)}</td>
                        <td data-label={L("النقل", "Transport")} className="num">{money(c.transport)}</td>
                        <td data-label={L("أخرى", "Other")} className="num">{money(c.otherAllowance)}</td>
                        <td data-label={L("الإجمالي", "Total")} className="num strong m-end">{money(c.total)}</td>
                        <td data-label={t("reason")}>{c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <p className="hr-caption" style={{ margin: 0 }}>{L("النسخ لا تتداخل؛ أي تعديل جديد ينهي النسخة السابقة في اليوم السابق لسريانه. المسيرات المعتمدة تحتفظ بنسخة المدخلات التي حُسبت بها. السجل الكامل في تبويب «العقود والرواتب».", "Versions never overlap: a new change ends the previous version the day before it takes effect. Approved runs keep the inputs they were calculated with. The full history is on the Contracts & payroll tab.")}</p>
          </section>
        ) : null}

        <section className="hr-stack">
          <SectionHead title={L("ملخص", "Summary")} />
          <KV rows={[
            [L("العقد الحالي", "Current contract"), cc ? <span key="c"><span className="hr-id">{cc.contractNo}</span> · {lbl(CONTRACT_TYPE, cc.type, lang)}{cc.endDate ? <> {L("حتى", "until")} <span className="hr-num">{cc.endDate}</span></> : null}</span> : L("لا يوجد عقد ساري", "No active contract"), cc ? undefined : "warning"],
            ...(perm.leave ? [[
              L("رصيد الإجازات المتاح", "Available leave balance"),
              leave.error ? failed : !leave.data ? "…" : tracked.length === 0 ? L("لا توجد أنواع إجازة برصيد", "No leave types with a balance") : (
                <span key="l" style={{ display: "inline-flex", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {tracked.map((b) => <span key={b.leaveTypeId}>{leaveTypeName(b, lang)}: <span className="hr-num">{Number(b.available).toString()}</span> {L("يومًا", "days")}</span>)}
                </span>
              ),
            ] as [string, React.ReactNode]] : []),
            ...(snap && "upcomingLeave" in snap ? [[
              L("إجازات معتمدة قادمة", "Upcoming approved leave"),
              snap.upcomingLeave ? <span key="u">{leaveTypeName({ code: snap.upcomingLeave.typeCode, nameAr: snap.upcomingLeave.type }, lang)} · {dayCount(snap.upcomingLeave.days, lang)} · <span className="hr-num">{snap.upcomingLeave.startDate}</span> → <span className="hr-num">{snap.upcomingLeave.endDate}</span></span> : none,
            ] as [string, React.ReactNode]] : []),
            ...(perm.advances ? [[
              L("سلف قائمة", "Open advances"),
              adv.error ? failed : !adv.data ? "…" : openAdv.length === 0 ? none : <span key="a"><span className="hr-num">{openAdv.length}</span> · {L("متبقٍ", "remaining")} <span className="hr-num">{money(outstanding)}</span></span>,
              openAdv.length ? "warning" : undefined,
            ] as [string, React.ReactNode, string?]] : []),
            ...(profile.assets ? [[L("العهد لدى الموظف", "Assets held by the employee"), openAssets.length === 0 ? none : <span key="as">{openAssets.map((a) => a.name).join(L("، ", ", "))} · <span className="hr-id">{openAssets.map((a) => a.tag).join(L("، ", ", "))}</span></span>] as [string, React.ReactNode]] : []),
          ]} />
        </section>
      </div>

      <aside className="hr-stack hr-ov-aside" style={{ gap: 24 }}>
        {perm.privateView ? <div className="hr-ov-private"><PrivatePanel id={id} canEdit={perm.edit && !readOnly} /></div> : null}

        {profile.documents ? (
          <section className="hr-stack hr-ov-docs" aria-labelledby="ov-docs">
            <SectionHead title={L("المستندات", "Documents")} id="ov-docs" />
            {profile.documents.length === 0 ? (
              <p className="hr-caption" style={{ margin: 0 }}>{L("لا توجد مستندات مرفوعة.", "No documents uploaded.")}</p>
            ) : (
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow" aria-label={L("المستندات", "Documents")}>
                  <thead><tr><th>{L("المستند", "Document")}</th><th>{L("السرية", "Confidentiality")}</th><th className="num">{L("الانتهاء", "Expiry")}</th><th><span className="hr-sr">{L("تنزيل", "Download")}</span></th></tr></thead>
                  <tbody>
                    {profile.documents.slice(0, 5).map((d) => (
                      <tr key={d.id}>
                        <td data-label={L("المستند", "Document")} className="strong m-title hr-wrap">{d.title}<span className="sub is-line">{lbl(DOC_CATEGORY, d.category, lang)} · <span className="hr-num">{fileSize(d.sizeBytes)}</span></span><span className="hr-msub">{d.confidential ? L("سري", "Confidential") : L("عادي", "Normal")}{d.expiresOn ? <> · {L("ينتهي", "expires")} <span className="hr-num">{d.expiresOn}</span></> : null}</span></td>
                        <td data-label={L("السرية", "Confidentiality")}>{d.confidential ? <Dot tone="warning">{L("سري", "Confidential")}</Dot> : <Dot tone="neutral">{L("عادي", "Normal")}</Dot>}</td>
                        <td data-label={L("الانتهاء", "Expiry")} className="num">{d.expiresOn ?? "—"}</td>
                        <td data-label={L("تنزيل", "Download")} className="m-end"><a className="hr-btn is-ghost is-sm hr-iconbtn" href={`/api/hr/employees/${id}/documents/${d.id}`} download={d.fileName} aria-label={L(`تنزيل ${d.title}`, `Download ${d.title}`)} title={L("تنزيل", "Download")}><Download size={16} aria-hidden /></a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {profile.documents.length > 5 ? <span className="hr-caption">{L("و", "And ")}<span className="hr-num">{profile.documents.length - 5}</span> {L("مستندات أخرى في تبويب «المستندات».", "more documents on the Documents tab.")}</span> : null}
          </section>
        ) : null}

        <section className="hr-stack hr-ov-reminders">
          <SectionHead title={L("تذكيرات", "Reminders")} />
          {profile.reminders.length === 0 ? (
            <p className="hr-caption" style={{ margin: 0 }}>{L("لا تذكيرات خلال الستين يومًا القادمة.", "No reminders in the next 60 days.")}</p>
          ) : (
            <KV rows={profile.reminders.map((r) => [hrText(r.message, lang), <span key={r.kind + r.date} className="hr-num">{r.date}</span>, r.kind === "NOTICE_DEADLINE" || r.kind === "ID_EXPIRY" ? "warning" : "text-2"])} />
          )}
        </section>
      </aside>
    </div>
  );
}

function PrivatePanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const [data, setData] = useState<Private | null>(null);
  const [editing, setEditing] = useState(false);
  const a = useAction();
  const reveal = () => a.run("reveal", async () => setData(await hrFetch<Private>(`/api/hr/employees/${id}/private`)));
  const close = useCallback(() => setEditing(false), []);
  const { L, en } = useHrI18n();
  const show = (k: string, kind?: string) => {
    if (!data) return <span className="hr-muted" aria-label={L("مخفي", "Hidden")}>••••••</span>;
    const v = data[k];
    if (v === null || v === undefined || v === "") return "—";
    return kind === "date" || kind === "ltr" ? <span className={kind === "date" ? "hr-num" : "hr-iso"} dir="ltr">{v}</span> : v;
  };
  const fields = data ? PRIVATE_FIELDS : PRIVATE_FIELDS.filter((f) => PRIVATE_SUMMARY.includes(f.key));
  return (
    <section className="hr-stack">
      <SectionHead
        title={L("البيانات الخاصة", "Private data")}
        actions={data ? (
          <>
            {canEdit ? <Btn size="sm" onClick={() => setEditing(true)}>{L("تعديل", "Edit")}</Btn> : null}
            <Btn size="sm" variant="ghost" onClick={() => setData(null)}>{L("إخفاء", "Hide")}</Btn>
          </>
        ) : <Btn size="sm" busy={a.busy === "reveal"} onClick={reveal}>{L("إظهار البيانات", "Reveal data")}</Btn>}
      />
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <KV rows={fields.map((f) => [en ? f.en : f.label, show(f.key, f.kind)])} />
      <p className="hr-caption" style={{ margin: 0 }}>{L("كل عرض لهذه البيانات يُسجَّل في سجل الموظف باسمك ووقته.", "Every view of this data is logged in the employee’s audit log with your name and the time.")}</p>
      {editing && data ? <PrivateDialog id={id} initial={data} onClose={close} onSaved={(d) => { setData(d); setEditing(false); }} /> : null}
    </section>
  );
}

function PrivateDialog({ id, initial, onClose, onSaved }: { id: string; initial: Private; onClose: () => void; onSaved: (d: Private) => void }) {
  const f = useForm(Object.fromEntries(PRIVATE_FIELDS.map((x) => [x.key, initial[x.key] ?? ""])) as Record<string, string>);
  const a = useAction();
  const { L, t, en } = useHrI18n();
  const submit = () => a.run("save", async () => {
    // Send only what changed; the audit records field names, never values.
    const body = Object.fromEntries(Object.entries(f.v).filter(([k, v]) => v !== (initial[k] ?? "")).map(([k, v]) => [k, v === "" ? null : v]));
    if (Object.keys(body).length === 0) return onClose();
    onSaved(await mutate<Private>(`/api/hr/employees/${id}/private`, { method: "PUT", json: body }));
  });
  return (
    <Dialog open title={L("تعديل البيانات الخاصة", "Edit private data")} onClose={onClose} actions={<><Btn variant="primary" busy={a.busy === "save"} onClick={submit}>{t("save")}</Btn><Btn onClick={onClose}>{t("cancel")}</Btn></>}>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-form">
        {PRIVATE_FIELDS.map((x) => (
          <Field key={x.key} label={en ? x.en : x.label} help={x.key === "iban" ? L("حرفان ثم أرقام، دون مسافات", "Two letters then digits, no spaces") : undefined} wide={x.key === "address"}>
            {x.key === "address" ? (
              <textarea className="hr-textarea" {...f.bind(x.key)} />
            ) : (
              <input className="hr-input" type={x.kind === "date" ? "date" : "text"} dir={x.kind ? "ltr" : undefined} {...f.bind(x.key)} />
            )}
          </Field>
        ))}
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("يُسجَّل التعديل بأسماء الحقول التي تغيّرت فقط، دون قيمها.", "The change is logged by the names of the fields that changed, never their values.")}</p>
    </Dialog>
  );
}
