"use client";
// Owner decision 1, Option A — «الأشخاص الخارجيون / External persons» (HR settings, account
// editors only). A verified non-employee identity, e.g. an outside accountant: never on payroll,
// never a payee. Every change is a REQUEST that another account editor approves; identifying edits
// and deactivation end the verification. Identity numbers are shown masked only.
import { useState } from "react";
import { Btn, Dialog, Dot, Empty, ErrorState, Field, KV, LoadingTable, Notice, hrFetch, useAction, useForm, useHr, dateTimeIn } from "@/components/hr/ui";
import { useI18n } from "@/lib/i18n/context";

export type IdentityRegister = {
  externalPersons: { id: string; fullName: string; idMasked: string | null; organization: string | null; roleNote: string | null; accountId: string | null; accountName: string | null; active: boolean; verified: boolean; verifiedAt: string | null; verifiedByName: string | null }[];
  employees: { id: string; employeeNo: string; name: string; accountId: string | null; verified: boolean }[];
  logins: { id: string; name: string; role: string; active: boolean; personType: "EMPLOYEE" | "EXTERNAL" | null; personId: string | null; personName: string | null; verified: boolean }[];
  requests: { id: string; kind: "PERSON_VERIFY" | "EXTERNAL_PERSON_CHANGE" | "EMPLOYEE_IDENTITY_CHANGE"; op: string | null; status: string; fingerprint: string; reason: string; subjectType: string; subjectId: string | null; subjectName: string | null; idMasked: string | null; organization: string | null; accountId: string | null; warnings: { kind: string; ref: string }[]; attestation: string | null; attestationAr: string | null; requestedByName: string | null; requestedAt: string; decidedByName: string | null; mine: boolean }[];
  bootstrap: boolean;
};

const OP_AR: Record<string, string> = { CREATE: "إضافة شخص خارجي", UPDATE: "تعديل بيانات", LINK: "ربط حساب", UNLINK: "فك ربط الحساب", DEACTIVATE: "إيقاف" };
const OP_EN: Record<string, string> = { CREATE: "Add external person", UPDATE: "Edit details", LINK: "Link a login", UNLINK: "Unlink the login", DEACTIVATE: "Deactivate" };

export function useT() {
  const { lang } = useI18n();
  const ar = lang !== "en";
  return { ar, t: (a: string, e: string) => (ar ? a : e) };
}

/** Pending identity requests (verification and external-person changes) with their decision. */
export function IdentityRequests({ reg, onDecided }: { reg: IdentityRegister; onDecided: () => void }) {
  const { ar, t } = useT();
  const [deciding, setDeciding] = useState<IdentityRegister["requests"][number] | null>(null);
  const act = useAction();
  const pending = reg.requests.filter((r) => r.status === "PENDING");
  if (!pending.length) return null;
  const label = (r: IdentityRegister["requests"][number]) => (r.kind === "PERSON_VERIFY" ? t("توثيق هوية", "Identity verification") : r.kind === "EMPLOYEE_IDENTITY_CHANGE" ? t("تعديل بيانات هوية موظف", "Employee identity change") : (ar ? OP_AR : OP_EN)[r.op ?? ""] ?? r.op);
  const withdraw = (id: string) => act.run(`w${id}`, async () => { await hrFetch(`/api/employees/identity/requests/${id}/withdraw`, { json: {} }); onDecided(); });
  return (
    <div className="hr-stack" data-testid="hr-identity-requests">
      <h3 className="hr-section" style={{ fontSize: 15 }}>{t("طلبات الهوية بانتظار قرار شخص آخر — لم تُطبَّق بعد", "Identity requests awaiting another person — not applied yet")}</h3>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <ul className="hr-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {pending.map((r) => (
          <li key={r.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center", padding: 12, border: "1px solid var(--hr-border-subtle)", borderRadius: 10 }}>
            <span>
              <strong>{label(r)}</strong> · {r.subjectName ?? "—"}{r.idMasked ? <> · <bdi className="hr-num" dir="ltr">{r.idMasked}</bdi></> : null}
              {r.warnings.length ? <span className="hr-caption" style={{ display: "block", color: "var(--hr-warning, #92400e)" }}>{t("تنبيه: اسم مطابق لسجل آخر — تأكد أنه شخص مختلف", "Warning: the name matches another record — make sure it is a different person")} ({r.warnings.map((w) => w.ref).join(", ")})</span> : null}
              <span className="hr-caption" style={{ display: "block" }}>{t("طلبه", "Requested by")} {r.requestedByName ?? "—"} · {dateTimeIn(r.requestedAt)} · {r.reason}</span>
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              {r.mine ? <Btn size="sm" busy={act.busy === `w${r.id}`} onClick={() => void withdraw(r.id)}>{t("سحب الطلب", "Withdraw")}</Btn> : <Btn size="sm" variant="primary" onClick={() => setDeciding(r)}>{t("مراجعة وقرار", "Review and decide")}</Btn>}
            </span>
          </li>
        ))}
      </ul>
      {deciding ? <DecideDialog r={deciding} title={label(deciding) ?? ""} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); onDecided(); }} /> : null}
    </div>
  );
}

function DecideDialog({ r, title, onClose, onDone }: { r: IdentityRegister["requests"][number]; title: string; onClose: () => void; onDone: () => void }) {
  const { ar, t } = useT();
  const [attested, setAttested] = useState(false);
  const [note, setNote] = useState("");
  const act = useAction();
  const needsAttest = !!r.attestation;
  const decide = (decision: "APPROVE" | "REJECT") => act.run(decision, async () => {
    await hrFetch(`/api/employees/identity/requests/${r.id}/decide`, { json: { decision, expected: r.fingerprint, attested: decision === "APPROVE" && needsAttest ? attested : undefined, note } });
    onDone();
  });
  return (
    <Dialog open title={title} onClose={onClose} actions={<>
      <Btn variant="primary" disabled={needsAttest && !attested} busy={act.busy === "APPROVE"} onClick={() => void decide("APPROVE")}>{t("اعتماد وتطبيق", "Approve and apply")}</Btn>
      <Btn variant="danger" disabled={note.trim().length < 3} busy={act.busy === "REJECT"} onClick={() => void decide("REJECT")}>{t("رفض", "Reject")}</Btn>
      <Btn onClick={onClose}>{t("إغلاق", "Close")}</Btn>
    </>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <KV rows={[
        [t("الشخص", "Person"), `${r.subjectName ?? "—"} (${r.subjectType === "EMPLOYEE" ? t("موظف", "employee") : t("شخص خارجي", "external person")})`],
        [t("رقم الهوية", "Identity number"), <bdi key="i" className="hr-num" dir="ltr">{r.idMasked ?? "—"}</bdi>],
        ...(r.organization ? [[t("الجهة", "Organization"), r.organization] as [string, string]] : []),
        [t("السبب", "Reason"), r.reason],
        [t("البصمة", "Fingerprint"), <span key="f" className="hr-num" dir="ltr">{r.fingerprint}</span>],
      ]} />
      {r.warnings.length ? <Notice tone="warning">{t("الاسم يطابق سجلًا آخر. للشخص الواحد سجل واحد: تأكد من وثيقة الهوية أنه شخص مختلف.", "The name matches another record. One person has one record: check the identity document.")}</Notice> : null}
      {needsAttest ? (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12 }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} data-testid="hr-identity-attest" />
          <span>{ar ? r.attestationAr : r.attestation}</span>
        </label>
      ) : null}
      <Field label={t("ملاحظة (مطلوبة للرفض)", "Note (required to reject)")}><textarea className="hr-textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="hr-caption" style={{ margin: 0 }}>{t("لا يقرر الطلب مقدّمه ولا صاحب السجل؛ ويُرفض إن تغيّر السجل بعد تقديم الطلب.", "Neither the requester nor the person concerned decides; a request is refused if the record changed after it was made.")}</p>
    </Dialog>
  );
}

export function ExternalPersons() {
  const { t } = useT();
  const q = useHr<IdentityRegister>("/api/employees/identity");
  const [editing, setEditing] = useState<{ op: "CREATE" | "UPDATE" | "LINK"; person?: IdentityRegister["externalPersons"][number] } | null>(null);
  const [sent, setSent] = useState(false);
  const act = useAction();
  const simple = (op: "UNLINK" | "DEACTIVATE" | "VERIFY", id: string) => act.run(`${op}${id}`, async () => {
    const reason = window.prompt(t("السبب (5 أحرف على الأقل)", "Reason (at least 5 characters)")) ?? "";
    if (reason.trim().length < 5) return;
    if (op === "VERIFY") await hrFetch("/api/employees/identity/verify", { json: { subjectType: "EXTERNAL", subjectId: id, reason } });
    else await hrFetch("/api/employees/identity/external", { json: { op, externalId: id, reason } });
    setSent(true);
    q.reload();
  });
  const pendingFor = (id: string) => q.data?.requests.some((r) => r.status === "PENDING" && r.subjectId === id);
  return (
    <div className="hr-stack" data-testid="hr-external-persons">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 className="hr-section">{t("الأشخاص الخارجيون", "External persons")}</h2>
        <Btn onClick={() => setEditing({ op: "CREATE" })}>{t("+ طلب إضافة شخص خارجي", "+ Request an external person")}</Btn>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{t("هوية موثّقة لشخص ليس موظفًا (مثل محاسب خارجي): لا يدخل الرواتب ولا يكون مستفيدًا منها. كل إضافة أو تعديل أو ربط أو إيقاف طلبٌ يعتمده محرر حسابات آخر، والتوثيق بموافقة شخص ثانٍ.", "A verified identity of someone who is not an employee (e.g. an outside accountant): never on payroll, never paid by it. Every addition, edit, link or deactivation is a request another account editor approves; verification needs a second person.")}</p>
      {sent ? <Notice tone="success">{t("أُرسل الطلب. لا يتغير شيء حتى يعتمده محرر حسابات آخر.", "Request sent. Nothing changes until another account editor approves it.")}</Notice> : null}
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <LoadingTable rows={3} /> : null}
      {q.data ? <IdentityRequests reg={q.data} onDecided={q.reload} /> : null}
      {q.data?.bootstrap ? <Notice tone="warning">{t("سجل التوثيق فارغ: أول توثيق يعتمده محرر حسابات آخر غير موثّق بعد، ويُسجَّل ذلك في التدقيق. بعده لا يوثّق إلا شخص موثّق.", "The verification register is empty: the first verification may be approved by another, not yet verified, account editor (audited as such). After it, only a verified person verifies.")}</Notice> : null}
      {q.data && q.data.externalPersons.length === 0 ? <Empty title={t("لا أشخاص خارجيين", "No external persons")} body={t("أضف المحاسب الخارجي أو أي شخص يحمل مهام رواتب وليس موظفًا.", "Add the outside accountant or anyone holding payroll duties who is not an employee.")} /> : null}
      {q.data && q.data.externalPersons.length > 0 ? (
        <div className="hr-tablewrap">
          <table className="hr-table is-stack" aria-label={t("الأشخاص الخارجيون", "External persons")}>
            <thead><tr><th>{t("الاسم", "Name")}</th><th>{t("رقم الهوية", "ID number")}</th><th>{t("الجهة", "Organization")}</th><th>{t("الحساب", "Login")}</th><th>{t("التوثيق", "Verification")}</th><th>{t("الإجراءات", "Actions")}</th></tr></thead>
            <tbody>
              {q.data.externalPersons.map((x) => (
                <tr key={x.id}>
                  <td data-label={t("الاسم", "Name")} className="strong">{x.fullName}{x.roleNote ? <span className="hr-caption" style={{ display: "block" }}>{x.roleNote}</span> : null}</td>
                  <td data-label={t("رقم الهوية", "ID number")}><bdi className="hr-num" dir="ltr">{x.idMasked ?? "—"}</bdi></td>
                  <td data-label={t("الجهة", "Organization")}>{x.organization ?? "—"}</td>
                  <td data-label={t("الحساب", "Login")}>{x.accountName ?? "—"}</td>
                  <td data-label={t("التوثيق", "Verification")}>
                    {!x.active ? <Dot tone="cancelled">{t("موقوف", "Deactivated")}</Dot> : x.verified ? <Dot tone="success">{t("موثّقة", "Verified")}</Dot> : <Dot tone="warning">{t("هوية غير موثّقة", "Identity not verified")}</Dot>}
                    {x.verified && x.verifiedByName ? <span className="hr-caption" style={{ display: "block" }}>{t("وثّقها", "by")} {x.verifiedByName}</span> : null}
                  </td>
                  <td data-label={t("الإجراءات", "Actions")}>
                    {x.active ? (
                      <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                        {pendingFor(x.id) ? <span className="hr-caption">{t("طلب قيد القرار", "Request pending")}</span> : <>
                          {!x.verified ? <Btn size="sm" variant="primary" busy={act.busy === `VERIFY${x.id}`} onClick={() => void simple("VERIFY", x.id)}>{t("طلب توثيق", "Request verification")}</Btn> : null}
                          <Btn size="sm" onClick={() => setEditing({ op: "UPDATE", person: x })}>{t("تعديل", "Edit")}</Btn>
                          {x.accountId ? <Btn size="sm" busy={act.busy === `UNLINK${x.id}`} onClick={() => void simple("UNLINK", x.id)}>{t("فك الربط", "Unlink")}</Btn> : <Btn size="sm" onClick={() => setEditing({ op: "LINK", person: x })}>{t("ربط حساب", "Link a login")}</Btn>}
                          <Btn size="sm" variant="danger" busy={act.busy === `DEACTIVATE${x.id}`} onClick={() => void simple("DEACTIVATE", x.id)}>{t("إيقاف", "Deactivate")}</Btn>
                        </>}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing && q.data ? <ExternalDialog op={editing.op} person={editing.person} logins={q.data.logins.filter((l) => !l.personType)} onClose={() => setEditing(null)} onDone={() => { setEditing(null); setSent(true); q.reload(); }} /> : null}
    </div>
  );
}

function ExternalDialog({ op, person, logins, onClose, onDone }: { op: "CREATE" | "UPDATE" | "LINK"; person?: IdentityRegister["externalPersons"][number]; logins: IdentityRegister["logins"]; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const f = useForm({ fullName: person?.fullName ?? "", idNumber: "", organization: person?.organization ?? "", roleNote: person?.roleNote ?? "", accountId: "", reason: "" });
  const act = useAction();
  const submit = () => act.run("s", async () => {
    const body: Record<string, unknown> = { op, reason: f.v.reason.trim() };
    if (person) body.externalId = person.id;
    if (op === "CREATE" || op === "UPDATE") Object.assign(body, { fullName: f.v.fullName, organization: f.v.organization, roleNote: f.v.roleNote, ...(op === "CREATE" || f.v.idNumber ? { idNumber: f.v.idNumber } : {}) });
    if ((op === "CREATE" && f.v.accountId) || op === "LINK") body.accountId = f.v.accountId;
    await hrFetch("/api/employees/identity/external", { json: body });
    onDone();
  });
  const title = op === "CREATE" ? t("طلب إضافة شخص خارجي", "Request an external person") : op === "UPDATE" ? t("طلب تعديل بيانات شخص خارجي", "Request an edit") : t("طلب ربط حساب", "Request a login link");
  const ok = f.v.reason.trim().length >= 5 && (op === "LINK" ? !!f.v.accountId : f.v.fullName.trim().length >= 3);
  return (
    <Dialog open title={title} onClose={onClose} actions={<><Btn variant="primary" disabled={!ok} busy={act.busy === "s"} onClick={submit}>{t("إرسال للاعتماد", "Send for approval")}</Btn><Btn onClick={onClose}>{t("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        {op !== "LINK" ? <>
          <Field label={t("الاسم الكامل *", "Full name *")}><input className="hr-input" maxLength={160} {...f.bind("fullName")} /></Field>
          <Field label={t("رقم الهوية / الإقامة / الجواز", "National ID / iqama / passport")} help={op === "UPDATE" ? t("اتركه فارغًا ليبقى كما هو. تغيير الاسم أو الرقم يُلغي التوثيق.", "Leave empty to keep it. Changing the name or number ends the verification.") : t("اختياري، وفريد إن أُدخل. لا يُقبل رقم يخص موظفًا: للشخص الواحد سجل واحد.", "Optional; unique when given. A number on an employee record is refused: one person, one record.")}><input className="hr-input" dir="ltr" maxLength={40} {...f.bind("idNumber")} /></Field>
          <Field label={t("الجهة", "Organization")}><input className="hr-input" maxLength={160} {...f.bind("organization")} /></Field>
          <Field label={t("ملاحظة الدور", "Role note")}><input className="hr-input" maxLength={300} {...f.bind("roleNote")} /></Field>
        </> : null}
        {op === "CREATE" || op === "LINK" ? (
          <Field label={op === "LINK" ? t("الحساب *", "Login *") : t("الحساب (اختياري)", "Login (optional)")} help={t("حسابات غير مرتبطة بأي شخص فقط.", "Logins linked to no person only.")}>
            <select className="hr-input" {...f.bind("accountId")}>
              <option value="">—</option>
              {logins.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label={t("السبب *", "Reason *")} help={t("يُحفظ في سجل التدقيق.", "Kept in the audit trail.")}><textarea className="hr-textarea" maxLength={300} {...f.bind("reason")} /></Field>
      </div>
    </Dialog>
  );
}
