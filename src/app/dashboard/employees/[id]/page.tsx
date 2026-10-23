"use client";

// UR-02 · ملف المستخدم (Figma 597:759 at 1440, 609:5249 at 1024, 613:7053 at 390) and its tabs:
//   نظرة عامة · الصلاحيات الفعلية (UR-08 599:1121 / 610:5121 / 615:6701) · الاستثناءات (UR-09
//   602:1869 / 602:2227 / 615:6785) · محطات العمل (UR-13: no station model yet — disabled) ·
//   الأجهزة والجلسات (UR-02d 598:966) · السجل (UR-02e 598:1335 / 602:2577, after a save).
// Header actions (administrator, not one's own account): «إيقاف الوصول» (UR-11), «إعادة تعيين بيانات
// الدخول» (UR-04), «تعديل الصلاحيات» (UR-02b). Own profile: read-only with «ملفي والأمان» (UR-S07);
// a viewer without the administrator role sees everything without the buttons (UR-S06).
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Dot, OpsLoading } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { LEVEL_AR, LEVEL_EN, moduleLabel, subLabel } from "@/lib/users/catalog";
import {
  Avatar, Latin, SensFlag, SrcTag, StatusWord, Tag, UsersFrame, api, deviceText, errText, fmtDate, fmtShort, fmtTime, fmtWhen, METHOD_WORD, useLangL, useUsersChrome,
  type DeviceInfo, type Source, type UserStatus,
} from "../_ui/shared";
import { AddOverrideDialog, ConfirmDialog, CredentialsDialog, RevokeDialog, TempPasswordDialog, valueWord } from "../_ui/dialogs";
import { Workstations } from "../_ui/workstations";

type Cells = Record<string, { access: string; sub: Record<string, boolean> }>;
type EffRow = { module: string; sub: string | null; value: string; roleValue: string; source: Source; sensitive: boolean; override?: { id?: string; reason: string; expiresAt: string | null; reviewAt: string | null; createdAt?: string; createdByName?: string | null; recorded: boolean } | null };
type Group = { key: string; ar: string; en: string; open: boolean; modules: { row: EffRow; subs: EffRow[] }[] };
type Override = { id: string; module: string; sub: string | null; effect: string; value: string; roleValue: string; sensitive: boolean; reason: string; expiresAt: string | null; reviewAt: string | null; createdAt: string; createdByName: string | null; endedAt: string | null; endReason: string | null };
type Event = { id: string; at: string; actor: string; actorId: string | null; action: string; label: string; target: string; source: string; details: string; reason: string | null; result: string; device: DeviceInfo; diff: { key: string; label: string; before: string; after: string }[] | null };
type Profile = {
  id: string; name: string; username: string | null; role: { key: string; id: string; name: string; nameEn: string; system: boolean }; customized: boolean;
  status: UserStatus; active: boolean; self: boolean; lock: { attempts: number; since: string | null } | null;
  hr: { id: string; name: string; jobTitle: string; department: string | null } | null; external: boolean;
  createdAt: string; createdByName: string | null; lastPermissionChange: { at: string; byName: string | null } | null;
  lastSignIn: { at: string; method: string; device: DeviceInfo } | null;
  password: { set: boolean; temporary: boolean; tempExpiresAt: string | null; changedAt: string | null };
  pin: { set: boolean; resetPending: boolean; changedAt: string | null };
  stationPin?: { set: boolean; setAt: string | null; locked: boolean };
  template: Cells; effective: Cells; groups: Group[]; overrides: Override[]; sensitive: { key: string; module: string; sub: string | null; source: string }[];
  powerUser: boolean;
  events: Event[]; caps: { view: boolean; manage: boolean; manageThis: boolean; accessThis: boolean; powerUser: boolean; limit: Cells | null; simpleMode: boolean }; computedAt: string;
};
type Tab = "overview" | "effective" | "exceptions" | "stations" | "sessions" | "log";

/** «غيّر الصلاحيات» + «إبراهيم عبدالله» → «غيّر إبراهيم عبدالله الصلاحيات» (UR-02e titles). */
function verbActor(label: string, actor: string, ar: boolean): string {
  if (!ar || actor === "النظام" || actor === "—") return ar || actor === "—" ? label : `${actor}: ${label}`;
  const [verb, ...rest] = label.split(" ");
  return [verb, actor, ...rest].join(" ");
}

export default function UserProfilePage() {
  return <Suspense fallback={null}><UserProfilePageInner /></Suspense>;
}

function UserProfilePageInner() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const { lang, ar, L } = useLangL();
  const tab = ((sp.get("tab") as Tab) || "overview") as Tab;
  const saved = sp.get("saved") === "1";
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dlg, setDlg] = useState<null | "cred" | "revoke" | "reactivate" | "override" | { removeOverride: Override | EffRow } | { session: string } | { device: string } | "endAll">(null);
  const [temp, setTemp] = useState<{ password: string; expiresAt: string; pending: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => setReload((x) => x + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api<Profile>(`/api/users/${id}`);
      if (cancelled) return;
      if (r.ok) { setP(r.data); setError(null); } else setError(errText(r.data, lang, L("تعذّر تحميل المستخدم.", "Could not load the user.")));
    })();
    return () => { cancelled = true; };
  }, [id, reload, lang, L]);

  useUsersChrome({
    title: p?.name ?? null,
    crumbs: [{ text: L("المستخدمون", "Users"), href: "/dashboard/employees" }],
    phone: p ? { title: p.name, sub: L("المستخدمون", "Users"), back: "/dashboard/employees", ownBar: tab === "overview" && p.caps.accessThis } : null,
  });

  const setTab = (t: Tab) => router.replace(`/dashboard/employees/${id}${t === "overview" ? "" : `?tab=${t}`}`, { scroll: false });
  const activeOverrides = p ? p.overrides.filter((o) => !o.endedAt) : [];
  const tabs: { key: Tab; label: string; count?: number; soon?: boolean; hidden?: boolean }[] = [
    { key: "overview", label: L("نظرة عامة", "Overview") },
    { key: "effective", label: L("الصلاحيات الفعلية", "Effective permissions") },
    { key: "exceptions", label: L("الاستثناءات", "Exceptions"), count: activeOverrides.length },
    { key: "stations", label: L("محطات العمل", "Workstations") },
    { key: "sessions", label: L("الأجهزة والجلسات", "Devices & sessions"), hidden: !p?.caps.manage },
    { key: "log", label: L("السجل", "History") },
  ];

  if (error) return <UsersFrame><div className="hr-notice tone-danger" role="alert">{error} <Btn size="sm" onClick={refresh}>{L("إعادة المحاولة", "Retry")}</Btn></div></UsersFrame>;
  if (!p) return <UsersFrame><OpsLoading rows={8} label={L("جارٍ تحميل الملف…", "Loading…")} /></UsersFrame>;

  const roleName = ar ? p.role.name : p.role.nameEn;
  const first = p.name.split(" ")[0];
  return (
    <UsersFrame testId="ur-profile">
      <header className="ur-phead">
        <div className="ur-pid">
          <Avatar name={p.name} size="lg" />
          <div>
            <h1 className="hr-title">{p.name}</h1>
            <div className="ur-meta">
              {p.username ? <><Latin>{p.username}</Latin><i aria-hidden /></> : null}
              <StatusWord status={p.status} lang={lang} /><i aria-hidden />
              <span>{roleName}</span>{p.customized ? <Tag>{L("مخصص", "Custom")}</Tag> : null}
              {p.powerUser ? <Tag testId="ur-power-chip">{L("مستخدم متقدّم", "Power user")}</Tag> : null}
              <i aria-hidden className="ur-hide-phone" /><span className="ur-hide-phone">{L("ملف الموظف", "HR record")}: {p.hr ? L("مرتبط", "linked") : p.external ? L("شخص خارجي", "external person") : L("غير مرتبط", "not linked")}</span>
            </div>
          </div>
        </div>
        <div className="ur-pacts ur-hide-phone">
          {p.self ? <Link className="hr-btn" href="/dashboard/profile" data-testid="ur-own-profile">{L("ملفي والأمان", "My profile & security")}</Link> : p.caps.manageThis ? (
            <>
              {p.active
                ? <Btn className="ur-danger" onClick={() => setDlg("revoke")} data-testid="ur-revoke">{L("إيقاف الوصول", "Revoke access")}</Btn>
                : <Btn onClick={() => setDlg("reactivate")} data-testid="ur-reactivate">{L("إعادة التفعيل", "Reactivate")}</Btn>}
              <Btn onClick={() => setDlg("cred")} data-testid="ur-credentials">{L("إعادة تعيين بيانات الدخول", "Reset credentials")}</Btn>
              <Link className="hr-btn is-primary" href={`/dashboard/employees/${p.id}/access`} data-testid="ur-edit-access">{L("تعديل الصلاحيات", "Edit permissions")}</Link>
            </>
          ) : p.caps.accessThis ? (
            // A power user (owner decision 19 Oct): permissions only — credentials and revocation stay
            // with the administrator.
            <Link className="hr-btn is-primary" href={`/dashboard/employees/${p.id}/access`} data-testid="ur-edit-access">{L("تعديل الصلاحيات", "Edit permissions")}</Link>
          ) : null}
        </div>
      </header>

      {p.self ? <div className="hr-notice tone-info" data-testid="ur-self-notice"><strong>{L("لا يمكنك تغيير دورك أو صلاحياتك.", "You cannot change your own role or permissions.")}</strong> {L("يغيّرها مسؤول آخر. كلمة المرور والأجهزة من «ملفي والأمان».", "Another administrator does. Your password and devices are in “My profile & security”.")}</div> : null}
      {p.lock && p.caps.manageThis ? <div className="hr-notice tone-danger" role="status" data-testid="ur-locked"><strong>{L(`الحساب مقفل${p.lock.since ? ` منذ ${fmtWhen(p.lock.since, lang)}` : ""}`, "The account is locked")}</strong> {L(`${p.lock.attempts} محاولات دخول فاشلة. لا يستطيع الدخول حتى يُفتح القفل.`, `${p.lock.attempts} failed sign-ins. It cannot sign in until unlocked.`)}</div> : null}
      {notice ? <div className="hr-notice tone-success" role="status">{notice}</div> : null}

      <nav className="hr-tabs is-underline ur-tabs" role="tablist" aria-label={L("أقسام الملف", "Profile sections")} data-testid="ur-profile-tabs">
        {tabs.filter((t) => !t.hidden).map((t) => t.soon ? (
          <span key={t.key} className="hr-tab ur-tab-soon" aria-disabled="true" title={L("يتطلب نموذج المحطات (I-10) — مخطط", "Needs the station model (I-10) — planned")}>{t.label}<em>{L("قريباً", "Soon")}</em></span>
        ) : (
          <button key={t.key} type="button" role="tab" className="hr-tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} data-testid={`ur-ptab-${t.key}`}>
            {t.label}{t.count ? <span className="hr-count">{t.count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "overview" ? <Overview p={p} goLog={() => setTab("log")} /> : null}
      {tab === "effective" ? <Effective p={p} /> : null}
      {tab === "exceptions" ? <Exceptions p={p} onAdd={() => setDlg("override")} onRemove={(o) => setDlg({ removeOverride: o })} /> : null}
      {tab === "stations" ? <Workstations p={p} onSaved={refresh} /> : null}
      {tab === "sessions" && p.caps.manage ? <Sessions p={p} reload={reload} onEnd={(ref) => setDlg({ session: ref })} onDevice={(ref) => setDlg({ device: ref })} onAll={() => setDlg("endAll")} /> : null}
      {tab === "log" ? <History p={p} saved={saved} /> : null}

      {p.caps.manageThis && tab === "overview" ? (
        // UR-11 on a phone (616:7199): Figma reaches «إيقاف الوصول» from the header's «…»; the shell's
        // phone header takes a link, not a menu, so the same action sits under the overview.
        <p className="ur-phone-only" style={{ margin: "16px 0 0" }}>
          {p.active
            ? <button type="button" className="ur-link is-danger" onClick={() => setDlg("revoke")} data-testid="ur-revoke-phone">{L("إيقاف الوصول", "Revoke access")}</button>
            : <button type="button" className="ur-link" onClick={() => setDlg("reactivate")} data-testid="ur-reactivate-phone">{L("إعادة التفعيل", "Reactivate")}</button>}
        </p>
      ) : null}
      {p.caps.accessThis && tab === "overview" ? (
        <div className="ur-sticky">
          {p.caps.manageThis ? <Btn onClick={() => setDlg("cred")}>{L("بيانات الدخول", "Credentials")}</Btn> : null}
          <Link className="hr-btn is-primary" href={`/dashboard/employees/${p.id}/access`}>{L("تعديل الصلاحيات", "Edit permissions")}</Link>
        </div>
      ) : null}

      {p.caps.manageThis ? (
        <>
          <CredentialsDialog open={dlg === "cred"} onClose={() => setDlg(null)} user={p} lock={p.lock} stationPinLocked={!!p.stationPin?.locked} onDone={(r) => {
            setDlg(null);
            if (r.action === "reset_password" && r.temporaryPassword) setTemp({ password: r.temporaryPassword, expiresAt: r.expiresAt!, pending: !r.applied });
            else setNotice(r.action === "unlock" ? L("فُتح القفل. يستطيع الدخول بكلمة المرور الحالية.", "Unlocked.") : r.action === "reenable_station_pin" ? L(`أُعيد تفعيل رمز المحطة. يستطيع ${first} الدخول به من جديد.`, "The station PIN was re-enabled.") : L(`أُلغي رمز المحطة. يعيّن ${first} رمزًا جديدًا بنفسه.`, "The PIN was cleared."));
            refresh();
          }} />
          {temp ? <TempPasswordDialog open onClose={() => setTemp(null)} name={p.name} username={p.username} password={temp.password} expiresAt={temp.expiresAt} pending={temp.pending} primaryLabel={L("تم", "Done")} onPrimary={() => setTemp(null)} /> : null}
          <RevokeDialog open={dlg === "revoke"} onClose={() => setDlg(null)} user={p} onDone={(deleted) => { setDlg(null); if (deleted) router.push("/dashboard/employees"); else { setNotice(L("أُوقف الوصول وأُنهيت الجلسات.", "Access revoked; sessions ended.")); refresh(); } }} />
          <ConfirmDialog open={dlg === "reactivate"} onClose={() => setDlg(null)} title={L(`إعادة تفعيل ${p.name}؟`, `Reactivate ${p.name}?`)} sub={L("يعود الدخول بالدور والصلاحيات المحفوظة.", "Sign-in returns with the saved role and permissions.")} confirmLabel={L("إعادة التفعيل", "Reactivate")} testId="ur-reactivate-dialog"
            run={async (reason) => { const r = await api(`/api/users/${p.id}/reactivate`, { method: "POST", body: { reason } }); if (r.ok) { setDlg(null); refresh(); } return r; }} />
        </>
      ) : null}
      {p.caps.accessThis ? (
        <>
          <AddOverrideDialog open={dlg === "override"} onClose={() => setDlg(null)} user={p} template={p.template} effective={p.effective} simpleMode={p.caps.simpleMode} onDone={() => { setDlg(null); router.replace(`/dashboard/employees/${p.id}?tab=log&saved=1`); refresh(); }} />
          {dlg && typeof dlg === "object" && "removeOverride" in dlg ? (
            <ConfirmDialog open onClose={() => setDlg(null)} title={L("إزالة الاستثناء؟", "Remove the exception?")} sub={L("تعود الخانة إلى قيمة الدور من الطلب التالي.", "The cell returns to the role's value from the next request.")} confirmLabel={L("إزالة", "Remove")} testId="ur-remove-override"
              run={async (reason) => {
                const o = dlg.removeOverride;
                const r = "id" in o && o.id && "effect" in o
                  ? await api(`/api/users/${p.id}/overrides/${o.id}`, { method: "DELETE", body: { reason } })
                  : await api(`/api/users/${p.id}/overrides`, { method: "POST", body: { cell: o.sub ? `${o.module}.${o.sub}` : o.module, value: o.roleValue, reason } });
                if (r.ok) { setDlg(null); refresh(); }
                return r;
              }} />
          ) : null}
        </>
      ) : null}
      {p.caps.manageThis ? (
        <>
          {dlg && typeof dlg === "object" && ("session" in dlg || "device" in dlg) ? (
            <ConfirmDialog open onClose={() => setDlg(null)} needReason={false} title={"session" in dlg ? L("إنهاء الجلسة؟", "End the session?") : L("إلغاء الثقة بالجهاز؟", "Revoke the device?")} sub={L("تنتهي من الخادم فورًا، ويُسجَّل ذلك باسمك.", "It ends on the server at once, recorded in your name.")} confirmLabel={"session" in dlg ? L("إنهاء الجلسة", "End session") : L("إلغاء الثقة", "Revoke")} danger testId="ur-end-session"
              run={async () => { const r = "session" in dlg ? await api(`/api/users/${p.id}/sessions/${dlg.session}`, { method: "DELETE" }) : await api(`/api/users/${p.id}/sessions`, { method: "DELETE", body: { device: dlg.device } }); if (r.ok) { setDlg(null); refresh(); } return r; }} />
          ) : null}
          <ConfirmDialog open={dlg === "endAll"} onClose={() => setDlg(null)} needReason={false} title={L("إنهاء كل الجلسات؟", "End every session?")} sub={L("تنتهي كل جلساته على كل الأجهزة فورًا؛ عليه الدخول من جديد.", "Every session on every device ends at once.")} confirmLabel={L("إنهاء كل الجلسات", "End all sessions")} danger testId="ur-end-all"
            run={async () => { const r = await api(`/api/users/${p.id}/sessions`, { method: "DELETE", body: {} }); if (r.ok) { setDlg(null); refresh(); } return r; }} />
        </>
      ) : null}
    </UsersFrame>
  );
}

function levelWord(v: string, ar: boolean) { return (ar ? LEVEL_AR : LEVEL_EN)[v] ?? v; }

/** «يستطيع» / «لا يستطيع» from the effective matrix (users.py overview). */
function capabilities(p: Profile, lang: "ar" | "en") {
  const ar = lang === "ar";
  const can: string[] = [];
  const cannot: string[] = [];
  for (const g of p.groups) {
    const open = g.modules.filter((m) => m.row.value !== "none");
    if (!open.length) { cannot.push(ar ? g.ar : g.en); continue; }
    for (const m of open) {
      const grant = m.row.source === "grant" && m.row.override?.expiresAt ? ` · ${ar ? "حتى" : "until"} ${fmtShort(m.row.override.expiresAt, lang)}` : "";
      can.push(`${moduleLabel(m.row.module, lang)}: ${levelWord(m.row.value, ar)}${grant}`);
    }
  }
  const join = (xs: string[]) => (ar ? (xs.length > 1 ? `${xs.slice(0, -1).join("، ")} و${xs[xs.length - 1]}` : xs[0] ?? "") : xs.join(", "));
  return { can, cannot: cannot.length ? [join(cannot)] : [] };
}

function Overview({ p, goLog }: { p: Profile; goLog: () => void }) {
  const { lang, ar, L } = useLangL();
  const { can, cannot } = capabilities(p, lang);
  const recent = p.events.filter((e) => !["SIGN_IN", "MFA_SIGN_IN", "SIGN_OUT"].includes(e.action)).slice(0, 3);
  const sensLabel = (s: Profile["sensitive"][number]) => (s.sub ? subLabel(s.module, s.sub, lang) : `${moduleLabel(s.module, lang)} · ${levelWord(p.effective[s.module].access, ar)}`);
  return (
    <div className="ur-page" data-testid="ur-overview">
      <div className="ur-cols">
        <dl className="ur-props">
          <div><dt>{L("الاسم المعروض", "Display name")}</dt><dd>{p.name}</dd></div>
          <div><dt>{L("اسم المستخدم", "Username")}</dt><dd>{p.username ? <Latin>{p.username}</Latin> : "—"}</dd></div>
          <div><dt>{L("ملف الموظف", "HR record")}</dt><dd>{p.hr ? <Link href={`/dashboard/hr/employees/${p.hr.id}`}>{p.hr.name}{p.hr.department ? ` · ${p.hr.department}` : ""}</Link> : p.external ? L("شخص خارجي موثّق", "Verified external person") : L("غير مرتبط", "Not linked")}</dd></div>
          <div><dt>{L("الدور", "Role")}</dt><dd><span className="ur-role">{ar ? p.role.name : p.role.nameEn}{p.customized ? <Tag>{L("مخصص", "Custom")}</Tag> : null}</span></dd></div>
          <div><dt>{L("أُنشئ", "Created")}</dt><dd>{fmtDate(p.createdAt, lang)}{p.createdByName ? ` · ${p.createdByName}` : ""}</dd></div>
          <div><dt>{L("آخر تغيير للصلاحيات", "Last permission change")}</dt><dd>{p.lastPermissionChange ? `${fmtDate(p.lastPermissionChange.at, lang)} ${fmtTime(p.lastPermissionChange.at)}${p.lastPermissionChange.byName ? ` · ${p.lastPermissionChange.byName}` : ""}` : "—"}</dd></div>
          <div><dt>{L("آخر دخول", "Last sign-in")}</dt><dd>{p.lastSignIn ? `${fmtWhen(p.lastSignIn.at, lang)} · ${ar ? METHOD_WORD[p.lastSignIn.method]?.ar ?? "" : METHOD_WORD[p.lastSignIn.method]?.en ?? ""} · ${L("ويب", "Web")}` : "—"}</dd></div>
          <div><dt>{L("كلمة المرور", "Password")}</dt><dd>{p.password.temporary ? L(`مؤقتة · تنتهي ${fmtWhen(p.password.tempExpiresAt, lang)} إن لم تُستخدم`, `Temporary · expires ${fmtWhen(p.password.tempExpiresAt, lang)} if unused`) : p.password.changedAt ? L(`غُيّرت في ${fmtDate(p.password.changedAt, lang)}`, `Changed on ${fmtDate(p.password.changedAt, lang)}`) : p.password.set ? L("معيّنة", "Set") : L("غير معيّنة", "Not set")}</dd></div>
          <div><dt>{L("رمز المحطة", "Station PIN")}</dt><dd data-testid="ur-station-pin-state">{p.stationPin
            ? (p.stationPin.locked ? L("مقفل بعد محاولات خاطئة · يعيد المسؤول تفعيله من «إعادة تعيين بيانات الدخول»", "Locked after wrong attempts · re-enabled from “Reset credentials”") : p.stationPin.set ? L(`عيّنه الموظف في ${fmtDate(p.stationPin.setAt, lang)}`, `Set by the employee on ${fmtDate(p.stationPin.setAt, lang)}`) : L("غير معيّن · يعيّنه الموظف بنفسه من «ملفي» بعد التحقق من هويته", "Not set · the person sets it in their profile after confirming their identity"))
            : p.pin.resetPending ? L("غير معيّن · يعيّنه الموظف بنفسه بعد التحقق من هويته", "Not set · the person sets it after confirming their identity") : p.pin.set ? L("معيّن", "Set") : L("غير معيّن", "Not set")}</dd></div>
        </dl>
        <div>
          <p className="ur-lbl">{L("يستطيع", "Can")}</p>
          {can.length ? <ul className="ur-can" data-testid="ur-can">{can.map((c) => <li key={c}>{c}</li>)}</ul> : <p className="ur-muted" style={{ margin: 0, fontSize: 13.5 }}>{L("لا شيء غير صفحة ملفه.", "Nothing but their own profile.")}</p>}
          {cannot.length ? <><p className="ur-lbl" style={{ marginTop: 16 }}>{L("لا يستطيع", "Cannot")}</p><ul className="ur-can is-neg">{cannot.map((c) => <li key={c}>{c}</li>)}</ul></> : null}
          {p.sensitive.length ? (
            <div className="ur-sensbox" data-testid="ur-sensitive">
              <SensFlag lang={lang} />
              <span>{p.sensitive.slice(0, 3).map(sensLabel).join("، ")}{p.sensitive.length > 3 ? (ar ? ` و${p.sensitive.length - 3} أخرى` : ` and ${p.sensitive.length - 3} more`) : ""} · {p.sensitive.every((s) => s.source === "override") ? L("ممنوح كاستثناء", "granted as an exception") : L("من الدور", "from the role")}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="ur-bh" style={{ marginTop: 12 }}><h2>{L("آخر التغييرات", "Recent changes")}</h2><button type="button" className="ur-link ur-blink" onClick={goLog}>{L("السجل الكامل", "Full history")}</button></div>
      {recent.length ? (
        <ol className="ur-tl is-compact">
          {recent.map((e, i) => (
            <li key={e.id} className={i === 0 ? "is-first" : undefined}>
              <div className="ur-tlt">{e.details ? `${e.label} «${e.details}»`.replace(/«(.{60}).+»$/, "«$1…»") : e.label}{e.actor !== "النظام" ? ` · ${e.actor}` : ""}</div>
              <div className="ur-tlw">{fmtDate(e.at, lang)} · {fmtTime(e.at)}</div>
            </li>
          ))}
        </ol>
      ) : <p className="ur-muted" style={{ margin: 0, fontSize: 13.5 }}>{L("لا تغييرات مسجّلة.", "No recorded changes.")}</p>}
    </div>
  );
}

function srcExtra(r: EffRow, lang: "ar" | "en") {
  if (r.source === "grant" && r.override?.expiresAt) return ` · ${lang === "ar" ? "حتى" : "until"} ${fmtShort(r.override.expiresAt, lang)}`;
  if (r.source === "expired" && r.override?.expiresAt) return ` · ${fmtShort(r.override.expiresAt, lang)}`;
  return "";
}

function Effective({ p }: { p: Profile }) {
  const { lang, ar, L } = useLangL();
  const openGroups = p.groups.filter((g) => g.open);
  const closed = p.groups.filter((g) => !g.open);
  const note = (r: EffRow) => r.source === "expired" ? L("انتهى؛ عاد إلى قيمة الدور", "Ended; back to the role's value") : r.override?.recorded ? r.override.reason : r.source !== "role" ? L("بلا سبب مسجّل", "No recorded reason") : "";
  function download() {
    const rows: string[][] = [];
    const head = [L("الوحدة والإجراء", "Module / action"), L("النتيجة", "Result"), L("المصدر", "Source"), L("ملاحظة", "Note")];
    for (const g of p.groups) for (const m of g.modules) {
      rows.push([moduleLabel(m.row.module, lang), valueWord(m.row.value, lang), m.row.source, note(m.row)]);
      for (const s of m.subs) if (m.row.value !== "none") rows.push([`  ${subLabel(s.module, s.sub!, lang)}`, valueWord(s.value, lang), s.source, note(s)]);
    }
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const url = URL.createObjectURL(new Blob(["﻿" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `effective-${p.username ?? p.id}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  return (
    <div className="ur-page" data-testid="ur-effective">
      <div className="ur-tool" style={{ fontSize: 13, color: "var(--text-muted)" }}>
        <span>{L("يحسبها الخادم: الدور ∪ المنح − المنع", "Computed by the server: role ∪ grants − denies")}</span><span aria-hidden>·</span>
        <span>{L("حُسبت", "Computed")} {fmtTime(p.computedAt)} · Asia/Riyadh</span>
        <span className="tl-sp" />
        <Btn size="sm" onClick={download} data-testid="ur-eff-download"><Ico name="dl" small />{L("تنزيل", "Download")}</Btn>
      </div>
      <div className="hr-tablewrap">
        <table className="hr-table ur-table ur-eff" aria-label={L("الصلاحيات الفعلية", "Effective permissions")}>
          <thead><tr><th>{L("الوحدة والإجراء", "Module and action")}</th><th>{L("النتيجة", "Result")}</th><th>{L("المصدر", "Source")}</th><th className="ur-hide-rail">{L("ملاحظة", "Note")}</th></tr></thead>
          <tbody>
            {openGroups.map((g) => [
              <tr key={g.key} className="ur-grp"><td colSpan={4}>{ar ? g.ar : g.en}</td></tr>,
              ...g.modules.flatMap((m) => [
                <tr key={m.row.module}>
                  <td style={{ fontWeight: 600 }}>{moduleLabel(m.row.module, lang)}{m.row.sensitive && m.row.value !== "none" ? <> <SensFlag lang={lang} /></> : null}</td>
                  <td className={`ur-val${m.row.value === "none" ? " is-none" : ""}`}>{levelWord(m.row.value, ar)}</td>
                  <td><SrcTag source={m.row.source} lang={lang} extra={srcExtra(m.row, lang)} /></td>
                  <td className="ur-hide-rail ur-muted">{note(m.row)}</td>
                </tr>,
                ...(m.row.value === "none" ? [] : m.subs.filter((s) => s.value === "true" || s.source !== "role").map((s) => (
                  <tr key={`${s.module}.${s.sub}`} className="ur-subrow">
                    <td>{subLabel(s.module, s.sub!, lang)}{s.sensitive ? <> <SensFlag lang={lang} /></> : null}</td>
                    <td>{s.value === "true" ? <Dot tone="success">{L("مسموح", "Allowed")}</Dot> : <Dot tone="warning">{L("ممنوع", "Denied")}</Dot>}</td>
                    <td><SrcTag source={s.source} lang={lang} extra={srcExtra(s, lang)} /></td>
                    <td className="ur-hide-rail ur-muted">{note(s)}</td>
                  </tr>
                ))),
              ]),
            ])}
            {closed.length ? <tr className="ur-grp"><td colSpan={4}>{L("مجموعات بلا وصول", "Groups with no access")}</td></tr> : null}
            {closed.map((g) => (
              <tr key={g.key}>
                <td><b style={{ fontWeight: 600 }}>{ar ? g.ar : g.en}</b> <span className="ur-muted" style={{ fontSize: 12.5 }}>· {ar ? `${g.modules.length === 1 ? "وحدة واحدة" : g.modules.length === 2 ? "وحدتان" : `${g.modules.length} وحدات`}` : `${g.modules.length} modules`}</span></td>
                <td className="ur-val is-none">{L("لا وصول", "No access")}</td>
                <td><SrcTag source="role" lang={lang} /></td>
                <td className="ur-hide-rail ur-muted">{L("كل وحداتها", "All its modules")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ur-foot">{L("الموارد البشرية مجموعة مقترحة تحددها المرحلة 6. الوصول إلى محطات العمل في تبويب «محطات العمل».", "Human resources is a proposed group set by phase 6. Workstation access is in the “Workstations” tab.")}</p>
    </div>
  );
}

function Exceptions({ p, onAdd, onRemove }: { p: Profile; onAdd: () => void; onRemove: (o: Override | EffRow) => void }) {
  const { lang, ar, L } = useLangL();
  const shown = p.overrides.filter((o) => !o.endedAt || o.endReason === "EXPIRED");
  // A cell that differs from the role with no exception on record (set before exceptions existed).
  const unrecorded = p.groups.flatMap((g) => g.modules.flatMap((m) => [m.row, ...m.subs])).filter((r) => (r.source === "grant" || r.source === "deny") && r.override && !r.override.recorded && (r.sub === null || p.effective[r.module].access !== "none"));
  const label = (module: string, sub: string | null, value: string) => (sub ? subLabel(module, sub, lang) : `${moduleLabel(module, lang)} · ${levelWord(value, ar)}`);
  return (
    <div className="ur-page" data-testid="ur-exceptions">
      <div className="ur-tool" style={{ alignItems: "flex-end" }}>
        <p className="ur-lead">{L("الاستثناء يمنح صلاحية لا يتيحها الدور أو يمنع صلاحية يتيحها. لكل استثناء سبب. الصلاحية الحساسة المؤقتة تتطلب تاريخ انتهاء، والدائمة تتطلب اعتمادًا ومراجعة دورية. المنع يتقدّم على منح الدور.", "An exception grants what the role does not, or denies what it does. Every exception has a reason. A temporary sensitive grant needs an expiry; a permanent one needs approval and periodic review. A deny wins over the role's grant.")}</p>
        <span className="tl-sp" />
        {p.caps.accessThis ? <Btn variant="primary" onClick={onAdd} data-testid="ur-add-override"><Ico name="plus" small />{L("إضافة استثناء", "Add exception")}</Btn> : null}
      </div>
      {shown.length || unrecorded.length ? (
        <div className="hr-tablewrap">
          <table className="hr-table ur-table" aria-label={L("الاستثناءات", "Exceptions")} data-testid="ur-overrides-table">
            <thead><tr><th>{L("الصلاحية", "Permission")}</th><th>{L("النوع", "Type")}</th><th>{L("السبب", "Reason")}</th><th>{L("الانتهاء", "Expiry")}</th><th className="ur-hide-rail">{L("أضافه", "Added by")}</th><th aria-hidden /></tr></thead>
            <tbody>
              {shown.map((o) => {
                const ended = !!o.endedAt;
                return (
                  <tr key={o.id} className={ended ? "is-ended" : undefined}>
                    <td className="ur-wrap"><span className={ended ? "ur-strike" : undefined} style={{ fontWeight: ended ? 400 : 500 }}>{label(o.module, o.sub, o.value)}</span>{o.sensitive ? <> <SensFlag lang={lang} /></> : null}<span className="ur-sub2">{moduleLabel(o.module, lang)}</span></td>
                    <td><SrcTag source={ended ? "expired" : o.effect === "GRANT" ? "grant" : "deny"} lang={lang} /></td>
                    <td className="ur-wrap">{o.reason}</td>
                    <td className="ur-wrap">{ended ? L(`انتهى ${fmtDate(o.expiresAt, lang)}`, `Ended ${fmtDate(o.expiresAt, lang)}`) : o.expiresAt ? fmtDate(o.expiresAt, lang) : o.reviewAt ? <>{L("دائمة", "Permanent")}<span className="ur-sub2">{L("مراجعة", "Review")} {fmtDate(o.reviewAt, lang)}</span></> : L("بلا انتهاء", "No expiry")}</td>
                    <td className="ur-hide-rail ur-wrap">{o.createdByName ?? "—"}<span className="ur-sub2">{fmtDate(o.createdAt, lang)}</span></td>
                    <td style={{ textAlign: "end" }}>{!ended && p.caps.accessThis ? <Btn size="sm" onClick={() => onRemove(o)} data-testid={`ur-remove-${o.id}`}>{L("إزالة", "Remove")}</Btn> : null}</td>
                  </tr>
                );
              })}
              {unrecorded.map((r) => (
                <tr key={`u-${r.module}.${r.sub ?? ""}`}>
                  <td className="ur-wrap"><span style={{ fontWeight: 500 }}>{label(r.module, r.sub, r.value)}</span>{r.sensitive ? <> <SensFlag lang={lang} /></> : null}<span className="ur-sub2">{moduleLabel(r.module, lang)}</span></td>
                  <td><SrcTag source={r.source} lang={lang} /></td>
                  <td className="ur-wrap ur-muted">{L("بلا سبب مسجّل (قبل الاستثناءات)", "No recorded reason (before exceptions)")}</td>
                  <td>{L("بلا انتهاء", "No expiry")}</td>
                  <td className="ur-hide-rail">—</td>
                  <td style={{ textAlign: "end" }}>{p.caps.accessThis ? <Btn size="sm" onClick={() => onRemove(r)}>{L("إزالة", "Remove")}</Btn> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="hr-state"><p style={{ margin: 0 }}>{L("لا استثناءات: الصلاحيات كما يمنحها الدور.", "No exceptions: permissions are as the role gives them.")}</p></div>}
      <p className="ur-foot">{L("الاستثناء المنتهي يبقى في السجل ولا يؤثر في الصلاحيات. التغيير يسري من الطلب التالي للمستخدم.", "An ended exception stays in the history and has no effect. A change applies from the user's next request.")}</p>
    </div>
  );
}

type SessionData = { sessions: { ref: string; method: string; createdAt: string; lastSeenAt: string; device: DeviceInfo; deviceRef: string }[]; devices: { ref: string; device: DeviceInfo; lastSignInAt: string | null; lastSignInMethod: string | null; lastSeenAt: string; liveSessions: number }[] };
function Sessions({ p, reload, onEnd, onDevice, onAll }: { p: Profile; reload: number; onEnd: (ref: string) => void; onDevice: (ref: string) => void; onAll: () => void }) {
  const { lang, ar, L } = useLangL();
  const [d, setD] = useState<SessionData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api<SessionData>(`/api/users/${p.id}/sessions`).then((r) => (r.ok ? setD(r.data) : setErr(errText(r.data, lang, L("تعذّر التحميل.", "Could not load."))))); }, [p.id, reload, lang, L]);
  const cat = (x: DeviceInfo) => (x.category === "phone" ? L("هاتف", "Phone") : x.category === "tablet" ? L("جهاز لوحي", "Tablet") : L("حاسوب", "Computer"));
  const method = (m: string | null) => (m ? (ar ? METHOD_WORD[m]?.ar : METHOD_WORD[m]?.en) ?? m : "—");
  if (err) return <div className="hr-notice tone-danger">{err}</div>;
  if (!d) return <OpsLoading rows={4} />;
  const manage = p.caps.manageThis;
  return (
    <div className="ur-page" data-testid="ur-sessions">
      <div className="ur-bh"><h2>{L("الأجهزة الموثوقة الشخصية", "Personal trusted devices")}</h2><span className="ur-bsub">{L("من الدخول بكلمة المرور على جهازه", "from password sign-ins on their device")}</span>
        {manage ? <button type="button" className="ur-link is-danger ur-blink" onClick={onAll} disabled={!d.sessions.length}>{L("إلغاء الثقة بكل أجهزته", "Revoke all their devices")}</button> : null}</div>
      {d.devices.length ? (
        <div className="hr-tablewrap"><table className="hr-table ur-table">
          <thead><tr><th>{L("الجهاز", "Device")}</th><th>{L("الفئة · المنصة", "Category · platform")}</th><th>{L("آخر دخول ناجح", "Last successful sign-in")}</th><th>{L("الحالة", "Status")}</th><th aria-hidden /></tr></thead>
          <tbody>{d.devices.map((x) => (
            <tr key={x.ref}>
              <td style={{ fontWeight: 500 }}>{deviceText(x.device, lang)}</td>
              <td>{cat(x.device)} · {x.device.os ?? "—"}</td>
              <td>{x.lastSignInAt ? `${fmtWhen(x.lastSignInAt, lang)} · ${method(x.lastSignInMethod)}` : "—"}</td>
              <td>{x.liveSessions ? <Dot tone="success">{ar ? `${x.liveSessions} جلسة نشطة` : `${x.liveSessions} live`}</Dot> : <Dot tone="neutral">{L("بلا جلسة", "No session")}</Dot>}</td>
              <td style={{ textAlign: "end" }}>{manage && x.liveSessions ? <Btn size="sm" className="ur-danger" onClick={() => onDevice(x.ref)}>{L("إلغاء الثقة", "Revoke")}</Btn> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="ur-muted" style={{ margin: 0 }}>{L("لا أجهزة في آخر 90 يومًا.", "No devices in the last 90 days.")}</p>}

      <div className="ur-bh" style={{ marginTop: 16 }}><h2>{L("الجلسات النشطة", "Active sessions")}</h2><span className="ur-bsub">{ar ? `${d.sessions.length} جلسات · تنتهي من الخادم فور الإنهاء` : `${d.sessions.length} sessions · ended on the server at once`}</span>
        {manage ? <button type="button" className="ur-link ur-blink" onClick={onAll} disabled={!d.sessions.length} data-testid="ur-end-all-link">{L("إنهاء كل الجلسات", "End all sessions")}</button> : null}</div>
      {d.sessions.length ? (
        <div className="hr-tablewrap"><table className="hr-table ur-table" data-testid="ur-sessions-table">
          <thead><tr><th>{L("الجلسة", "Session")}</th><th>{L("طريقة الدخول", "Sign-in method")}</th><th>{L("بدأت", "Started")}</th><th>{L("آخر نشاط", "Last activity")}</th><th aria-hidden /></tr></thead>
          <tbody>{d.sessions.map((s) => (
            <tr key={s.ref}>
              <td style={{ fontWeight: 500 }}>{L("ويب", "Web")} · {deviceText(s.device, lang)}</td>
              <td>{method(s.method)}</td>
              <td>{fmtWhen(s.createdAt, lang)}</td>
              <td>{fmtWhen(s.lastSeenAt, lang)}</td>
              <td style={{ textAlign: "end" }}>{manage ? <Btn size="sm" onClick={() => onEnd(s.ref)}>{L("إنهاء الجلسة", "End session")}</Btn> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="ur-muted" style={{ margin: 0 }}>{L("لا جلسات نشطة.", "No active sessions.")}</p>}
      <p className="ur-foot">{L("محطات المصنع المشتركة تُدار في «أجهزة المحطات». كل إنهاء أو إلغاء يتطلب كلمة مرورك ويُسجَّل باسمك.", "Shared factory stations are managed in “Station devices”. Every end or revoke needs your password and is recorded in your name.")}</p>
    </div>
  );
}

function History({ p, saved }: { p: Profile; saved: boolean }) {
  const { lang, ar, L } = useLangL();
  const first = p.name.split(" ")[0];
  const items = useMemo(() => p.events, [p.events]);
  return (
    <div className="ur-page" data-testid="ur-history">
      {saved ? <div className="ur-ok" role="status" data-testid="ur-saved"><b>{L("حُفظت التغييرات", "Changes saved")}</b><span>{L(`تسري من الطلب التالي لـ${first}؛ تُحدَّث شاشاته عند إعادة التحميل.`, `They apply from ${first}'s next request; their screens update on reload.`)}</span></div> : null}
      {items.length ? (
        <ol className="ur-tl">
          {items.map((e, i) => (
            <li key={e.id} className={i === 0 ? "is-first" : undefined}>
              <div className="ur-tlt">{verbActor(e.label, e.actor, ar)}</div>
              {e.details ? <div className="ur-tld">{e.action.startsWith("SIGN") || e.action === "MFA_SIGN_IN" ? `${deviceText(e.device, lang)}${e.details ? ` · ${e.details}` : ""}` : e.details.replace(/ · السبب: .*$/, "")}</div> : e.action.startsWith("SIGN") ? <div className="ur-tld">{deviceText(e.device, lang)}</div> : null}
              {e.reason ? <span className="ur-diff">{L("السبب", "Reason")}: {e.reason}</span> : null}
              <div className="ur-tlw">{fmtWhen(e.at, lang)}</div>
            </li>
          ))}
        </ol>
      ) : <p className="ur-muted" style={{ margin: 0 }}>{L("لا أحداث مسجّلة.", "No recorded events.")}</p>}
    </div>
  );
}

