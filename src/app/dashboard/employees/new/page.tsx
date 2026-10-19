"use client";

// UR-03 · مستخدم جديد (Figma 601:1710 step 1, 601:2009 step 3, 603:2427 / 612:6707 step 4, 603:2707
// the one-time credentials, 615:6934 step 3 on a phone; users.py create_*). Four steps: identity (an
// HR record or a standalone account) → credentials → role → review. A new account starts at «بلا
// وصول» (P-1); a role is chosen explicitly; sensitive actions in the role's modules are never given
// by the role and each needs a reason and an expiry (P-3 / O-2). The temporary password is generated
// by the server and shown once; the station PIN is set later by the person themselves (J-6).
// Administrator only — the server refuses everyone else (and asks for the password again).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Btn, OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { GROUPS, isSensitive, moduleLabel, subLabel, subsOf } from "@/lib/users/catalog";
import { type Cells } from "@/lib/users/model";
import { useUnsavedGuard } from "../../_components/useUnsavedGuard";
import { Avatar, Latin, NoAccess, PasswordConfirmField, SensFlag, UsersFrame, api, endOfDayRiyadh, errText, useLangL, usePasswordConfirm, useUsersChrome } from "../_ui/shared";
import { TempPasswordDialog } from "../_ui/dialogs";

type Person = { id: string; fullNameAr: string; fullNameEn: string | null; employeeNo: string; jobTitle: string; department: { nameAr: string } | null };
type Role = { id: string; system: boolean; key: string | null; name: string; nameEn: string; description: string; permissions: Cells };
type Avail = { username: string | null; valid: boolean; available: boolean; suggestion: string | null };

export default function NewUserPage() {
  const router = useRouter();
  const { lang, ar, L } = useLangL();
  const [step, setStep] = useState(1);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"hr" | "standalone">("hr");
  const [personId, setPersonId] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [avail, setAvail] = useState<Avail | null>(null);
  const [phone, setPhone] = useState("");
  const [roleId, setRoleId] = useState("custom");
  const [allRoles, setAllRoles] = useState(false);
  const [sens, setSens] = useState<string[]>([]);
  const [sensReason, setSensReason] = useState("");
  const [sensExpiry, setSensExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string; username: string | null; temporaryPassword: string; expiresAt: string } | null>(null);
  const pc = usePasswordConfirm();

  useUsersChrome({
    title: L("مستخدم جديد", "New user"),
    crumbs: [{ text: L("المستخدمون", "Users"), href: "/dashboard/employees" }],
    phone: { title: L("مستخدم جديد", "New user"), sub: name || undefined, back: "/dashboard/employees", ownBar: true },
  });
  useEffect(() => {
    void (async () => {
      const [p, r] = await Promise.all([api<{ people: Person[] }>("/api/users/people"), api<{ roles: Role[] }>("/api/roles?all=1")]);
      setAllowed(p.ok);
      if (p.ok) setPeople(p.data.people);
      if (r.ok) setRoles(r.data.roles);
    })();
  }, []);
  useEffect(() => {
    const u = username.trim();
    if (!u) return;
    const t = setTimeout(() => { void api<Avail>(`/api/users/username?u=${encodeURIComponent(u)}`).then((r) => r.ok && setAvail(r.data)); }, 300);
    return () => clearTimeout(t);
  }, [username]);
  // The answer for the username as typed now (none while the field is empty).
  const shownAvail = username.trim() && avail && (avail.username === username.trim() || !avail.valid) ? avail : null;
  const dirty = !created && (!!name || !!username || !!personId);
  useUnsavedGuard(dirty);

  const person = people?.find((x) => x.id === personId) ?? null;
  const role = roles?.find((r) => r.id === roleId) ?? null;
  const shortList = useMemo(() => {
    if (!roles) return [];
    const order = ["custom", "qc", "roasting", "dispatch"];
    return allRoles ? [roles.find((r) => r.id === "custom")!, ...roles.filter((r) => r.id !== "custom")].filter(Boolean) : order.map((k) => roles.find((r) => r.id === k)).filter((x): x is Role => !!x);
  }, [roles, allRoles]);
  const sensOptions = useMemo(() => (role ? GROUPS.flatMap((g) => g.modules).filter((m) => role.permissions[m].access !== "none").flatMap((m) => subsOf(m).filter((s) => isSensitive(m, s) && !role.permissions[m].sub[s]).map((s) => ({ key: `${m}.${s}`, m, s }))) : []), [role]);
  const effective = useMemo(() => {
    if (!role) return { can: [] as string[], cannot: "" };
    const p = structuredClone(role.permissions);
    for (const k of sens) { const [m, s] = k.split("."); p[m].sub[s] = true; }
    const can = GROUPS.flatMap((g) => g.modules).filter((m) => p[m].access !== "none").map((m) => {
      const acts = subsOf(m).filter((s) => p[m].sub[s]).map((s) => subLabel(m, s, lang));
      const lvl = p[m].access === "edit" ? L("تعديل", "edit") : L("عرض", "view");
      return `${moduleLabel(m, lang)}: ${acts.length ? (acts.length > 3 ? `${acts.slice(0, 3).join("، ")}…` : acts.join("، ")) : lvl}`;
    });
    const missing = sensOptions.filter((o) => !sens.includes(o.key)).map((o) => subLabel(o.m, o.s, lang));
    return { can, cannot: missing.length ? L(`كل ما عدا ذلك، ومنه ${missing.slice(0, 2).join(" و")}`, `Everything else, including ${missing.slice(0, 2).join(" and ")}`) : L("كل ما عدا ذلك", "Everything else") };
  }, [role, sens, sensOptions, lang, L]);

  if (allowed === false) return <UsersFrame><NoAccess /></UsersFrame>;
  if (!people || !roles) return <UsersFrame><OpsLoading rows={6} /></UsersFrame>;

  const step1ok = name.trim().length > 0 && !!shownAvail?.valid && !!shownAvail.available && (mode === "standalone" || !!personId);
  const step3ok = !sens.length || (sensReason.trim().length >= 3 && !!sensExpiry);
  const canNext = step === 1 ? step1ok : step === 3 ? step3ok : true;
  const STEPS = [L("الهوية", "Identity"), L("بيانات الدخول", "Credentials"), L("الدور", "Role"), L("المراجعة", "Review")];

  async function create() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const body = { name: name.trim(), username: username.trim(), hrEmployeeId: mode === "hr" ? personId : null, phoneNumber: phone.trim() || undefined,
      ...(role?.system ? { role: role.key } : { accessRoleId: role?.id }), sensitive: sens, sensitiveReason: sens.length ? sensReason : undefined, sensitiveExpiresAt: sens.length ? endOfDayRiyadh(sensExpiry) : undefined };
    const r = await api<{ id: string; name: string; username: string | null; temporaryPassword: string; expiresAt: string }>("/api/users", { method: "POST", body });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر إنشاء المستخدم.", "Could not create the user."))); return; }
    setCreated(r.data);
  }
  const roleLine = (r: Role) => `${r.description ? `${r.description.replace(/\.$/, "")} · ` : ""}${r.system ? (r.id === "custom" ? "" : L("قالب النظام", "System template")) : L("دور مخصص", "Custom role")}`.replace(/ · $/, "");
  const primary = step === 4 ? L("إنشاء المستخدم", "Create user") : L("التالي", "Next");
  const onPrimary = () => (step === 4 ? void create() : setStep((s) => s + 1));
  const onBack = () => (step === 1 ? router.push("/dashboard/employees") : setStep((s) => s - 1));

  return (
    <UsersFrame testId="ur-new-user">
      <div className="ur-headtext">
        <h1 className="hr-title ur-hide-phone">{L("مستخدم جديد", "New user")}</h1>
        <div className="ur-meta ur-hide-phone"><span>{L("يبدأ الحساب الجديد بلا وصول؛ يُطبَّق الدور صراحة وتُعرض النتيجة قبل الإنشاء", "A new account starts with no access; the role is applied explicitly and the result shown before creating")}</span></div>
      </div>
      <ol className="ur-steps" aria-label={L(`الخطوة ${step} من 4`, `Step ${step} of 4`)} data-testid="ur-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i + 1 < step ? "is-done" : i + 1 === step ? "is-on" : undefined}>
            <span className="ur-stepdot">{i + 1 < step ? "✓" : i + 1}</span><span>{s}</span>{i < 3 ? <span className="ur-stepline" aria-hidden /> : null}
          </li>
        ))}
      </ol>
      <div className="ur-mstep"><div className="ur-bars">{STEPS.map((s, i) => <span key={s} className={i < step ? "is-on" : undefined} />)}</div><span className="ur-muted" style={{ fontSize: 12.5 }}>{L(`الخطوة ${step} من 4 · ${STEPS[step - 1]}`, `Step ${step} of 4 · ${STEPS[step - 1]}`)}</span></div>

      <div className="ur-wiz">
        {step === 1 ? (
          <>
            <div className="tl-radios">
              <label className={`tl-radio${mode === "hr" ? " is-on" : ""}`}><input type="radio" checked={mode === "hr"} onChange={() => setMode("hr")} /><span><strong>{L("ربط بملف موظف", "Link to an employee record")}</strong><span>{L("يأخذ الاسم والقسم من الموارد البشرية. يُنصح به لكل موظف.", "Takes the name and department from HR. Recommended for every employee.")}</span></span></label>
              <label className={`tl-radio${mode === "standalone" ? " is-on" : ""}`}><input type="radio" checked={mode === "standalone"} onChange={() => { setMode("standalone"); setPersonId(""); }} /><span><strong>{L("حساب مستقل", "Standalone account")}</strong><span>{L("لحسابات خدمة أو مستشار مؤقت؛ لا يُربط بملف موظف.", "For a service account or a temporary adviser; not linked to an employee record.")}</span></span></label>
            </div>
            {mode === "hr" ? (
              <>
                <label className="hr-field">
                  <span className="hr-label">{L("ملف الموظف", "Employee record")}<span className="ur-req"> *</span></span>
                  <Select value={personId} onChange={(e) => { setPersonId(e.target.value); const x = people.find((y) => y.id === e.target.value); if (x && !name) setName(x.fullNameAr); }} placeholder={people.length ? L("اختر…", "Choose…") : L("لا ملفات بلا حساب", "No records without a login")} data-testid="ur-new-person">
                    <option value="">—</option>
                    {people.map((x) => <option key={x.id} value={x.id}>{x.fullNameAr}{x.department ? ` · ${x.department.nameAr}` : ""}</option>)}
                  </Select>
                </label>
                {person ? <div className="ur-found"><Avatar name={person.fullNameAr} /><div><b style={{ fontWeight: 500 }}>{person.fullNameAr}</b><small>{[person.department?.nameAr, person.jobTitle, L("ملف موظف بلا حساب", "Employee record with no login")].filter(Boolean).join(" · ")}</small></div><Btn variant="ghost" size="sm" onClick={() => setPersonId("")}>{L("تغيير", "Change")}</Btn></div> : null}
              </>
            ) : null}
            <label className="hr-field"><span className="hr-label">{L("الاسم المعروض", "Display name")}<span className="ur-req"> *</span></span><input className="hr-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-testid="ur-new-name" /></label>
            <label className="hr-field">
              <span className="hr-label">{L("اسم المستخدم", "Username")}<span className="ur-req"> *</span></span>
              <input className="hr-input" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="off" maxLength={64} data-testid="ur-new-username" aria-invalid={shownAvail ? !shownAvail.available : undefined} />
              {shownAvail && !shownAvail.valid ? <span className="hr-err">{L("أحرف لاتينية صغيرة وأرقام و . _ - فقط، من 3 إلى 64.", "a–z, 0–9, dot, underscore or hyphen; 3–64 characters.")}</span>
                : shownAvail && !shownAvail.available ? <span className="hr-err" data-testid="ur-username-taken">{L(`مستخدَم لحساب آخر.${shownAvail.suggestion ? ` جرّب ${shownAvail.suggestion}` : ""}`, `Taken by another account.${shownAvail.suggestion ? ` Try ${shownAvail.suggestion}` : ""}`)}</span>
                : <span className="hr-help">{shownAvail?.available ? `${L("متاح", "Available")} · ` : ""}{L("أحرف لاتينية صغيرة وأرقام ونقطة. لا يُغيَّر بعد الإنشاء.", "Lower-case Latin letters, digits and dots. Cannot be changed after creation.")}</span>}
            </label>
          </>
        ) : step === 2 ? (
          <>
            <dl className="ur-props">
              <div><dt>{L("كلمة المرور", "Password")}</dt><dd>{L("مؤقتة، تُولَّد عند الإنشاء وتُعرض مرة واحدة · يجب تغييرها عند أول دخول · تنتهي بعد 72 ساعة إن لم تُستخدم", "Temporary, generated at creation and shown once · changed at first sign-in · expires after 72 hours if unused")}</dd></div>
              <div><dt>{L("رمز المحطة", "Station PIN")}</dt><dd>{L("يعيّنه الموظف بنفسه بعد الدخول والتحقق من هويته. لا يراه المسؤول ولا يعيّنه.", "The person sets it after signing in and confirming their identity. The administrator never sees or sets it.")}</dd></div>
            </dl>
            <label className="hr-field"><span className="hr-label">{L("رقم الجوال", "Mobile number")} <span className="ur-muted" style={{ fontWeight: 400 }}>{L("(اختياري)", "(optional)")}</span></span><input className="hr-input" type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} /><span className="hr-help">{L("لرسائل واتساب الآلية فقط.", "For automated WhatsApp messages only.")}</span></label>
          </>
        ) : step === 3 ? (
          <>
            <div className="tl-radios" data-testid="ur-new-roles">
              {shortList.map((r) => (
                <label key={r.id} className={`tl-radio${roleId === r.id ? " is-on" : ""}`}><input type="radio" checked={roleId === r.id} onChange={() => { setRoleId(r.id); setSens([]); }} /><span><strong>{ar ? r.name : r.nameEn}</strong><span>{roleLine(r) || L("الافتراضي. لا يرى المستخدم إلا صفحة ملفه.", "The default. The user sees only their profile.")}</span></span></label>
              ))}
            </div>
            {!allRoles && roles.length > shortList.length ? <p className="ur-muted" style={{ margin: 0, fontSize: 12.5 }}>{ar ? `${roles.length - shortList.length} أدوار أخرى · ` : `${roles.length - shortList.length} more roles · `}<button type="button" className="ur-link" onClick={() => setAllRoles(true)} data-testid="ur-all-roles">{L("عرض كل الأدوار", "Show all roles")}</button></p> : null}
            {sensOptions.length ? (
              <div className="ur-sens" data-testid="ur-new-sensitive">
                <b><SensFlag lang={lang} />{L("صلاحيات حساسة في وحدات هذا الدور", "Sensitive permissions in this role's modules")}</b>
                <p>{L("لا يمنحها الدور. فعّل ما يلزم فقط؛ كل واحدة تحتاج سببًا وتاريخ انتهاء.", "The role does not give them. Turn on only what is needed; each needs a reason and an expiry.")}</p>
                {sensOptions.map((o) => <label key={o.key} className="tl-check"><input type="checkbox" checked={sens.includes(o.key)} onChange={(e) => setSens((x) => (e.target.checked ? [...x, o.key] : x.filter((y) => y !== o.key)))} />{subLabel(o.m, o.s, lang)}</label>)}
                {sens.length ? (
                  <div className="ur-twocol">
                    <label className="hr-field"><span className="hr-label">{L("السبب", "Reason")}<span className="ur-req"> *</span></span><input className="hr-input" value={sensReason} onChange={(e) => setSensReason(e.target.value)} maxLength={300} /></label>
                    <label className="hr-field"><span className="hr-label">{L("ينتهي في", "Expires on")}<span className="ur-req"> *</span></span><input className="hr-input" type="date" value={sensExpiry} onChange={(e) => setSensExpiry(e.target.value)} /></label>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <dl className="ur-props" data-testid="ur-new-review">
              <div><dt>{L("ملف الموظف", "Employee record")}</dt><dd>{person ? `${person.fullNameAr}${person.department ? ` · ${person.department.nameAr}` : ""}` : L("حساب مستقل", "Standalone account")}</dd></div>
              <div><dt>{L("اسم المستخدم", "Username")}</dt><dd><Latin>{shownAvail?.username ?? username}</Latin></dd></div>
              <div><dt>{L("كلمة المرور", "Password")}</dt><dd>{L("مؤقتة، تُولَّد عند الإنشاء وتُعرض مرة واحدة · يجب تغييرها عند أول دخول", "Temporary, generated at creation and shown once · changed at first sign-in")}</dd></div>
              <div><dt>{L("رمز المحطة", "Station PIN")}</dt><dd>{L("يعيّنه الموظف بنفسه بعد التفعيل والتحقق من الهوية", "Set by the person after activation and identity check")}</dd></div>
              <div><dt>{L("الدور", "Role")}</dt><dd>{role ? `${ar ? role.name : role.nameEn}${role.system && role.id !== "custom" ? ` · ${L("قالب النظام", "System template")}` : ""}` : "—"}</dd></div>
              <div><dt>{L("صلاحيات حساسة", "Sensitive permissions")}</dt><dd>{sens.length ? sens.map((k) => { const [m, s] = k.split("."); return subLabel(m, s, lang); }).join("، ") : L("لا شيء", "None")}</dd></div>
            </dl>
            <p className="ur-lbl" style={{ marginTop: 6 }}>{L("الصلاحيات الفعلية بعد الإنشاء", "Effective permissions after creation")}</p>
            {effective.can.length ? <ul className="ur-can">{effective.can.map((c) => <li key={c}>{c}</li>)}</ul> : <p className="ur-muted" style={{ margin: 0, fontSize: 13.5 }}>{L("لا شيء غير صفحة ملفه.", "Nothing but their own profile.")}</p>}
            <ul className="ur-can is-neg"><li>{effective.cannot}</li></ul>
            <PasswordConfirmField pc={pc} hint={L("إنشاء مستخدم يتطلب كلمة المرور. لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Creating a user needs your password. Quick PIN and biometrics are not accepted.")} />
            {err ? <div className="hr-notice tone-danger" role="alert" data-testid="ur-new-error">{err}</div> : null}
          </>
        )}
      </div>
      <div className="ur-wizfoot">
        <span className="ur-muted" style={{ fontSize: 12.5 }}>{L(`الخطوة ${step} من 4`, `Step ${step} of 4`)}</span><span className="tl-sp" />
        <Btn variant={step === 1 ? "ghost" : undefined} onClick={onBack}>{step === 1 ? L("إلغاء", "Cancel") : L("السابق", "Back")}</Btn>
        <Btn variant="primary" busy={busy} disabled={!canNext} onClick={onPrimary} data-testid="ur-new-next">{primary}</Btn>
      </div>
      <div className="ur-sticky">
        <Btn onClick={onBack}>{step === 1 ? L("إلغاء", "Cancel") : L("السابق", "Back")}</Btn>
        <Btn variant="primary" busy={busy} disabled={!canNext} onClick={onPrimary}>{primary}</Btn>
      </div>
      {created ? <TempPasswordDialog open onClose={() => router.push(`/dashboard/employees/${created.id}`)} name={created.name} username={created.username} password={created.temporaryPassword} expiresAt={created.expiresAt} primaryLabel={L("فتح ملف المستخدم", "Open the user's profile")} onPrimary={() => router.push(`/dashboard/employees/${created.id}`)} /> : null}
    </UsersFrame>
  );
}
