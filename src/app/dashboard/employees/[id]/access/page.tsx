"use client";

// UR-02b · تعديل صلاحيات المستخدم (Figma 598:550 at 1440; the confirmation UR-10 «حفظ صلاحيات …؟»
// 612:6310 at 1024 and 616:7103 as a phone sheet). The role, the expiry of the new exceptions, and
// the matrix «النتيجة لهذا المستخدم»: every cell set here that differs from the role becomes an
// exception with the reason (P-2); a temporary sensitive grant needs the expiry (O-2). Saved through
// PUT /api/users/[id]/access after the reason and the password; then the profile's history (UR-02e).
// The administrator, or a power user within its guardrails (owner decision 19 Oct: never an
// administrator's account or role, never «مستخدم متقدّم», never above its own access), and never
// one's own account (the server refuses all of these); read-only on a phone.
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/hr/ui";
import { Btn, Dot, OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { usePhone } from "@/components/shell/page-context";
import { isSensitive, moduleLabel, subLabel } from "@/lib/users/catalog";
import { applyOverrides, type Cells, type OverrideLike } from "@/lib/users/model";
import { useUnsavedGuard } from "../../../_components/useUnsavedGuard";
import { Avatar, Latin, PasswordConfirmField, ReasonField, SensFlag, UsersFrame, api, endOfDayRiyadh, errText, fmtShort, useLangL, usePasswordConfirm, useUsersChrome } from "../../_ui/shared";
import { PermissionMatrix, applyEdit, changedCells } from "../../_ui/matrix";

type Role = { id: string; system: boolean; key: string | null; name: string; nameEn: string; permissions: Cells };
type Profile = {
  id: string; name: string; username: string | null; self: boolean; role: { key: string; id: string; name: string; nameEn: string; system: boolean };
  template: Cells; effective: Cells; overrides: (OverrideLike & { id: string })[]; caps: { manageThis: boolean; accessThis: boolean; powerUser: boolean; limit: Cells | null; simpleMode: boolean };
};

export default function EditAccessPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const phone = usePhone();
  const { lang, ar, L } = useLangL();
  const [p, setP] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string>("");
  const [cells, setCells] = useState<Cells | null>(null);
  const [expiry, setExpiry] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    void (async () => {
      const [a, b] = await Promise.all([api<Profile>(`/api/users/${id}`), api<{ roles: Role[] }>("/api/roles?all=1")]);
      if (!a.ok) { setError(errText(a.data, lang, L("تعذّر التحميل.", "Could not load."))); return; }
      setP(a.data); setRoleId(a.data.role.id); setCells(a.data.effective);
      if (b.ok) setRoles(b.data.roles);
    })();
  }, [id, lang, L]);

  useUsersChrome({
    title: L("تعديل الصلاحيات", "Edit permissions"),
    crumbs: [{ text: L("المستخدمون", "Users"), href: "/dashboard/employees" }, ...(p ? [{ text: p.name, href: `/dashboard/employees/${p.id}` }] : [])],
    phone: p ? { title: L("تعديل الصلاحيات", "Edit permissions"), sub: p.name, back: `/dashboard/employees/${p.id}` } : null,
  });

  const role = roles?.find((r) => r.id === roleId) ?? null;
  const roleChanged = !!p && roleId !== p.role.id;
  // The base the cells sit on: the chosen role's template with the exceptions in force (a role change
  // keeps them — «يستبدل القالب ويُبقي الاستثناءات»); before a role change, the stored values.
  const activeOverrides = useMemo(() => (p ? p.overrides.filter((o) => !o.endedAt) : []), [p]);
  const template = role?.permissions ?? p?.template ?? null;
  const base = useMemo(() => (p ? (roleChanged && template ? applyOverrides(template, activeOverrides) : p.effective) : null), [p, roleChanged, template, activeOverrides]);
  const diff = useMemo(() => (cells && base ? changedCells(cells, base) : []), [cells, base]);
  const vsStored = useMemo(() => (cells && p ? changedCells(cells, p.effective) : []), [cells, p]);
  const dirty = roleChanged || diff.length > 0;
  useUnsavedGuard(dirty);

  function pickRole(rid: string) {
    if (!p || !roles) return;
    setRoleId(rid);
    const r = roles.find((x) => x.id === rid);
    if (!r) return;
    setCells(rid === p.role.id ? p.effective : applyOverrides(r.permissions, activeOverrides));
  }
  const overrideOf = (m: string, s: string | null) => activeOverrides.find((o) => o.module === m && (o.sub ?? null) === s) ?? null;

  if (error) return <UsersFrame><div className="hr-notice tone-danger" role="alert">{error}</div></UsersFrame>;
  if (!p || !cells || !base) return <UsersFrame><OpsLoading rows={8} /></UsersFrame>;
  if (p.self || !p.caps.accessThis) {
    return (
      <UsersFrame>
        <div className="hr-notice tone-info" data-testid="ur-access-readonly"><strong>{p.self ? L("لا يمكنك تغيير دورك أو صلاحياتك.", "You cannot change your own role or permissions.") : p.caps.powerUser ? L("صلاحيات حساب مدير المنشأة يغيّرها مدير المنشأة فقط.", "Only the administrator changes an administrator's permissions.") : L("تعديل الصلاحيات لمدير المنشأة أو لمستخدم متقدّم يختاره.", "Only the administrator, or a power user they chose, edits permissions.")}</strong></div>
        <PermissionMatrix value={p.effective} original={p.effective} template={p.template} mode="user" readOnly />
      </UsersFrame>
    );
  }
  const newSensitive = vsStored.filter((c) => isSensitive(c.module, c.sub) && (c.sub === null ? ["view", "edit"].includes(c.to) && c.from === "none" : c.to === "true"));
  return (
    <UsersFrame testId="ur-access">
      <header className="ur-phead">
        <div className="ur-pid">
          <Avatar name={p.name} size="lg" />
          <div>
            <h1 className="hr-title">{L(`تعديل صلاحيات ${p.name}`, `Edit ${p.name}'s permissions`)}</h1>
            <div className="ur-meta">{p.username ? <><Latin>{p.username}</Latin><i aria-hidden /></> : null}<span>{L("التغيير يُنشئ استثناءً على الدور بسبب · المدة مطلوبة للصلاحية الحساسة", "A change makes an exception to the role, with a reason · sensitive permissions need a duration")}</span></div>
          </div>
        </div>
      </header>
      {p.caps.limit ? <div className="hr-notice tone-info" data-testid="ur-power-notice"><strong>{L("أنت مستخدم متقدّم.", "You are a power user.")}</strong> {L("تمنح ما تملكه أنت فقط، ولا تمنح دور «مدير المنشأة» ولا صلاحية «مستخدم متقدّم».", "You grant only what you hold yourself; never the administrator role or the power-user permission.")}</div> : null}
      {phone ? <div className="hr-notice tone-info" data-testid="ur-phone-readonly"><strong>{L("العرض فقط على الهاتف.", "View only on a phone.")}</strong> {L("عدّل الصلاحيات من شاشة أكبر.", "Edit permissions from a larger screen.")}</div> : null}
      <div className="ur-twocol">
        <label className="hr-field">
          <span className="hr-label">{L("الدور", "Role")}</span>
          <Select value={roleId} onChange={(e) => pickRole(e.target.value)} disabled={phone} data-testid="ur-access-role">
            {(roles ?? []).filter((r) => !p.caps.limit || r.key !== "admin" || r.id === p.role.id).map((r) => <option key={r.id} value={r.id}>{ar ? r.name : r.nameEn}</option>)}
          </Select>
          <span className="hr-help">{L("تغيير الدور يستبدل القالب ويُبقي الاستثناءات.", "Changing the role replaces the template and keeps the exceptions.")}</span>
        </label>
        <label className="hr-field">
          <span className="hr-label">{L("انتهاء الاستثناءات الجديدة", "Expiry of the new exceptions")} <span className="ur-muted" style={{ fontWeight: 400 }}>{L("(اختياري)", "(optional)")}</span></span>
          <input className="hr-input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={phone} data-testid="ur-access-expiry" />
          <span className="hr-help">{L("مطلوب لأي صلاحية حساسة مؤقتة.", "Required for any temporary sensitive permission.")}</span>
        </label>
      </div>
      <PermissionMatrix value={cells} original={base} template={template ?? p.template} mode="user" readOnly={phone} limit={p.caps.limit} expiresAt={expiry ? endOfDayRiyadh(expiry) : null}
        overrideOf={(m, s) => { const o = overrideOf(m, s); return o ? { expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null } : null; }}
        onChange={(m, s, v) => setCells((c) => (c ? applyEdit(c, m, s, v) : c))} />
      {dirty && !phone ? (
        <div className="ur-savebar" data-testid="ur-savebar">
          <span className="ur-dotw" aria-hidden />
          <span className="ur-n">{ar ? `${diff.length + (roleChanged ? 1 : 0)} تغييرات غير محفوظة` : `${diff.length + (roleChanged ? 1 : 0)} unsaved changes`}{newSensitive.length ? L(` · منها ${newSensitive.length === 1 ? "صلاحية حساسة واحدة" : `${newSensitive.length} حساسة`}`, ` · ${newSensitive.length} sensitive`) : ""}</span>
          <span className="tl-sp" />
          <Btn onClick={() => { setRoleId(p.role.id); setCells(p.effective); setExpiry(""); }} data-testid="ur-discard">{L("تجاهل", "Discard")}</Btn>
          <Btn variant="primary" onClick={() => setConfirm(true)} data-testid="ur-save">{L("حفظ التغييرات", "Save changes")}</Btn>
        </div>
      ) : null}
      <ConfirmUserChange open={confirm} onClose={() => setConfirm(false)} p={p} roleChanged={roleChanged} role={role} changes={vsStored} extra={diff} expiry={expiry} sensitive={newSensitive}
        onSaved={() => { setConfirm(false); setRoleId(p.role.id); setCells(p.effective); router.push(`/dashboard/employees/${p.id}?tab=log&saved=1`); }} />
    </UsersFrame>
  );
}

function ConfirmUserChange(props: Parameters<typeof ConfirmUserChangeInner>[0]) {
  return props.open ? <ConfirmUserChangeInner {...props} /> : null;
}

function ConfirmUserChangeInner({ open, onClose, p, roleChanged, role, changes, extra, expiry, sensitive, onSaved }: {
  open: boolean; onClose: () => void; p: Profile; roleChanged: boolean; role: Role | null; changes: ReturnType<typeof changedCells>; extra: ReturnType<typeof changedCells>; expiry: string; sensitive: ReturnType<typeof changedCells>; onSaved: () => void;
}) {
  const { lang, ar, L } = useLangL();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  const lvl = (v: string) => (ar ? { none: "لا وصول", view: "عرض", edit: "تعديل" } : { none: "No access", view: "View", edit: "Edit" })[v as "none"] ?? v;
  const until = expiry ? ` · ${L("حتى", "until")} ${fmtShort(endOfDayRiyadh(expiry), lang)}` : "";
  async function go() {
    setBusy(true); setErr(null);
    if (sensitive.length && !expiry) { setErr(L("مطلوب: الصلاحية الحساسة المؤقتة تتطلب تاريخ انتهاء. لم يُحفظ شيء.", "Required: a temporary sensitive permission needs an expiry date. Nothing was saved.")); setBusy(false); return; }
    if (!(await pc.confirm())) { setBusy(false); return; }
    // Every cell that differs from what is stored, and every cell set on top of the new role's base.
    const body: Record<string, unknown> = { cells: Object.fromEntries([...changes, ...extra].map((c) => [c.key, c.to])), reason, expiresAt: expiry ? endOfDayRiyadh(expiry) : null };
    if (roleChanged && role) { if (role.system) body.role = role.key; else body.accessRoleId = role.id; }
    const r = await api(`/api/users/${p.id}/access`, { method: "PUT", body });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return; }
    onSaved();
  }
  return (
    <Dialog open={open} onClose={onClose} title={L(`حفظ صلاحيات ${p.name}؟`, `Save ${p.name}'s permissions?`)} className="ur-dlg" testId="ur-confirm-user"
      sub={`${L("يسري من طلبه التالي؛ تُحدَّث شاشاته عند إعادة التحميل.", "Applies from their next request; their screens update on reload.")}${sensitive.length ? "" : ` ${L("لا صلاحيات حساسة مضافة.", "No sensitive permission added.")}`}`}
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} disabled={reason.trim().length < 3} onClick={go} data-testid="ur-confirm-user-go">{L("حفظ التغييرات", "Save changes")}</Btn></>}>
      <ul className="ur-changes" data-testid="ur-change-list">
        {roleChanged && role ? <li><Dot tone="info">{L("الدور", "Role")}</Dot> · {ar ? p.role.name : p.role.nameEn} ← {ar ? role.name : role.nameEn}</li> : null}
        {changes.map((c) => {
          const name = c.sub ? subLabel(c.module, c.sub, lang) : moduleLabel(c.module, lang);
          const up = c.sub ? c.to === "true" : ["none", "view", "edit"].indexOf(c.to) > ["none", "view", "edit"].indexOf(c.from);
          return <li key={c.key}>{up ? <Dot tone="success">{L("مضاف", "Added")}</Dot> : <Dot tone="warning">{L("ممنوع", "Denied")}</Dot>} · {c.sub ? `${moduleLabel(c.module, lang)}: ${name}` : `${name}: ${lvl(c.from)} ← ${lvl(c.to)}`}{up ? until : ""}</li>;
        })}
      </ul>
      {sensitive.length ? (
        <div className="ur-sens">
          <b><SensFlag lang={lang} />{L("صلاحية حساسة مضافة", "Sensitive permission added")}</b>
          {sensitive.map((c) => <span key={c.key}>{c.sub ? subLabel(c.module, c.sub, lang) : moduleLabel(c.module, lang)}</span>)}
          <p>{expiry ? L(`مؤقتة حتى ${fmtShort(endOfDayRiyadh(expiry), lang)}.`, `Temporary until ${fmtShort(endOfDayRiyadh(expiry), lang)}.`) : L("مطلوب: تاريخ انتهاء للصلاحية الحساسة المؤقتة.", "Required: an expiry for a temporary sensitive permission.")}</p>
        </div>
      ) : null}
      <ReasonField value={reason} onChange={setReason} required testId="ur-confirm-user-reason" />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid="ur-confirm-user-error">{err}</div> : null}
    </Dialog>
  );
}
