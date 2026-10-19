"use client";

// UR-06 · محرر الدور (Figma 605:3345 at 1440 with three unsaved changes, 611:5757 at 1024, 616:6899
// read-only at 390) and UR-10 «حفظ تغييرات دور …؟» (606:3557). A custom role: name, description, the
// matrix; saving rewrites every member's permissions from their next request (their exceptions kept),
// after the reason and the password. A system template is read-only and can be copied (UR-S14, O-3);
// «/roles/new» starts a custom role from «بلا وصول». Two editors at once: the later save is refused
// with who changed it (UR-S10). Administrator only; read-only on a phone (J-8 / O-7).
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/hr/ui";
import { Btn, Dot, OpsLoading } from "@/components/ops/ui";
import { usePhone } from "@/components/shell/page-context";
import { isSensitive, moduleLabel, subLabel } from "@/lib/users/catalog";
import { templateCells, type Cells } from "@/lib/users/model";
import { useUnsavedGuard } from "../../../_components/useUnsavedGuard";
import { PasswordConfirmField, ReasonField, SensFlag, UsersFrame, api, errText, fmtDate, useLangL, usePasswordConfirm, useUsersChrome } from "../../_ui/shared";
import { PermissionMatrix, applyEdit, changedCells } from "../../_ui/matrix";

type Role = { id: string; system: boolean; key: string | null; name: string; nameEn: string; description: string; members: number; sensitive: number; updatedAt: string | null; updatedByName: string | null; version: number; permissions: Cells; membersList: { id: string; name: string; active: boolean }[] };
type Conflict = { by: string | null; version: number };

export default function RoleEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const phone = usePhone();
  const { lang, ar, L } = useLangL();
  const [role, setRole] = useState<Role | null>(null);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cells, setCells] = useState<Cells | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [copying, setCopying] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void (async () => {
      if (isNew) {
        const r = await api<{ caps: { manage: boolean } }>("/api/roles");
        setManage(!!r.data.caps?.manage);
        const t = templateCells("custom");
        setRole({ id: "new", system: false, key: null, name: "", nameEn: "", description: "", members: 0, sensitive: 0, updatedAt: null, updatedByName: null, version: 0, permissions: t, membersList: [] });
        setCells(t); return;
      }
      const r = await api<{ role: Role; caps: { manage: boolean } }>(`/api/roles/${id}`);
      if (!r.ok) { setError(errText(r.data, lang, L("تعذّر تحميل الدور.", "Could not load the role."))); return; }
      setRole(r.data.role); setManage(r.data.caps.manage); setCells(r.data.role.permissions); setName(r.data.role.name); setDesc(r.data.role.description ?? "");
    })();
  }, [id, isNew, reload, lang, L]);

  const title = isNew ? L("دور جديد", "New role") : role ? (ar ? role.name : role.nameEn) : null;
  useUsersChrome({
    title,
    crumbs: [{ text: L("الأدوار", "Roles"), href: "/dashboard/employees/roles" }],
    phone: title ? { title, sub: role ? (role.system ? L("قالب النظام", "System template") : `${L("دور مخصص", "Custom role")} · ${role.members}`) : undefined, back: "/dashboard/employees/roles" } : null,
  });
  const diff = useMemo(() => (cells && role ? changedCells(cells, role.permissions) : []), [cells, role]);
  const metaChanged = !!role && !role.system && (name !== role.name || desc !== (role.description ?? ""));
  const dirty = diff.length > 0 || metaChanged;
  useUnsavedGuard(dirty);

  if (error) return <UsersFrame><div className="hr-notice tone-danger" role="alert">{error}</div></UsersFrame>;
  if (!role || !cells) return <UsersFrame><OpsLoading rows={8} /></UsersFrame>;
  const readOnly = role.system || !manage || phone;
  const sensAdded = diff.filter((c) => isSensitive(c.module, c.sub) && (c.sub === null ? c.from === "none" : c.to === "true"));

  async function copy() {
    setCopying(true);
    const r = await api<{ id: string }>(`/api/roles/${id}/duplicate`, { method: "POST" });
    setCopying(false);
    if (r.ok) router.push(`/dashboard/employees/roles/${r.data.id}`);
    else setError(errText(r.data, lang, L("تعذّر نسخ الدور.", "Could not copy the role.")));
  }
  const memberNames = role.membersList.map((m) => m.name);
  return (
    <UsersFrame testId="ur-role-editor">
      <header className="ur-phead">
        <div className="ur-headtext">
          <h1 className="hr-title">{isNew ? L("دور جديد", "New role") : ar ? role.name : role.nameEn}</h1>
          <div className="ur-meta">
            <span>{role.system ? L("قالب النظام", "System template") : L("دور مخصص", "Custom role")}</span>
            {!isNew ? <><i aria-hidden /><span>{ar ? `${role.members === 1 ? "مستخدم واحد" : role.members === 2 ? "مستخدمان" : `${role.members} مستخدمين`}${memberNames.length ? `: ${memberNames.slice(0, 3).join(" · ")}${memberNames.length > 3 ? " …" : ""}` : ""}` : `${role.members} users`}</span></> : null}
            {role.updatedAt ? <><i aria-hidden /><span>{L("آخر تغيير", "Last change")} {fmtDate(role.updatedAt, lang)}{role.updatedByName ? ` · ${role.updatedByName}` : ""}</span></> : null}
          </div>
        </div>
        {!isNew ? (
          <div className="ur-pacts">
            {manage ? <Btn variant="ghost" busy={copying} onClick={copy} data-testid="ur-copy-role">{L("نسخ الدور", "Copy role")}</Btn> : null}
            <Link className="hr-btn" href={`/dashboard/employees/roles/compare?with=${role.id}`}>{L("مقارنة", "Compare")}</Link>
          </div>
        ) : null}
      </header>

      {role.system ? <div className="hr-notice tone-info" data-testid="ur-system-template"><strong>{L(`«${role.name}» قالب نظام للقراءة فقط.`, `“${role.nameEn}” is a read-only system template.`)}</strong> {L("انسخه لإنشاء دور مخصص قابل للتعديل.", "Copy it to make an editable custom role.")}</div> : null}
      {phone && !role.system ? <div className="hr-notice tone-info" data-testid="ur-phone-readonly"><strong>{L("العرض فقط على الهاتف.", "View only on a phone.")}</strong> {L("عدّل الدور من شاشة أكبر.", "Edit the role from a larger screen.")}</div> : null}
      {conflict ? (
        <div className="hr-notice tone-warning" role="alert" data-testid="ur-role-conflict">
          <strong>{L(`عدّل ${conflict.by ?? "مسؤول آخر"} هذا الدور بعد أن فتحته.`, `${conflict.by ?? "Someone"} changed this role after you opened it.`)}</strong> {L("راجع تغييره ثم احفظ تغييراتك فوقه.", "Review their change, then save yours on top.")}
          <span style={{ display: "inline-flex", gap: 8, marginInlineStart: 8 }}>
            <Btn size="sm" variant="primary" onClick={() => { setConflict(null); setReload((x) => x + 1); }}>{L("مراجعة التغييرين", "Review both changes")}</Btn>
            <Btn size="sm" onClick={() => { setConflict(null); setCells(role.permissions); }}>{L("تجاهل تغييراتي", "Discard mine")}</Btn>
          </span>
        </div>
      ) : null}

      {!role.system && !readOnly ? (
        <div className="ur-twocol">
          <label className="hr-field"><span className="hr-label">{L("اسم الدور", "Role name")}<span className="ur-req"> *</span></span><input className="hr-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="ur-role-name" /></label>
          <label className="hr-field"><span className="hr-label">{L("الوصف", "Description")} <span className="ur-muted" style={{ fontWeight: 400 }}>{L("(اختياري)", "(optional)")}</span></span><input className="hr-input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} data-testid="ur-role-desc" /></label>
        </div>
      ) : role.description ? <p className="ur-lead">{role.description}</p> : null}
      {!readOnly ? <p className="ur-lead" style={{ fontSize: 13, color: "var(--text-muted)" }}>{L("مستوى «تعديل» لا يفعّل الإجراءات تلقائيًا. الإجراء الحساس يُفعَّل وحده، ويُطلب له سبب وتأكيد بكلمة المرور عند الحفظ.", "“Edit” never turns on an action. A sensitive action is turned on alone, with a reason and the password on save.")}</p> : null}

      <PermissionMatrix value={cells} original={role.permissions} mode="role" readOnly={readOnly} onChange={(m, s, v) => setCells((c) => (c ? applyEdit(c, m, s, v) : c))} testId="ur-role-matrix" />

      {!readOnly && (dirty || isNew) ? (
        <div className="ur-savebar" data-testid="ur-savebar">
          <span className="ur-dotw" aria-hidden />
          <span className="ur-n">{isNew ? L("دور جديد غير محفوظ", "New role, not saved") : ar ? `${diff.length + (metaChanged ? 1 : 0)} تغييرات غير محفوظة` : `${diff.length + (metaChanged ? 1 : 0)} unsaved changes`}{sensAdded.length ? L(` · منها ${sensAdded.length === 1 ? "صلاحية حساسة واحدة" : `${sensAdded.length} حساسة`}`, ` · ${sensAdded.length} sensitive`) : ""}</span>
          <span className="tl-sp" />
          <Btn onClick={() => { if (isNew) router.push("/dashboard/employees/roles"); else { setCells(role.permissions); setName(role.name); setDesc(role.description ?? ""); } }} data-testid="ur-discard">{L("تجاهل", "Discard")}</Btn>
          <Btn variant="primary" disabled={!name.trim()} onClick={() => setConfirm(true)} data-testid="ur-save">{L("حفظ التغييرات", "Save changes")}</Btn>
        </div>
      ) : null}

      <ConfirmRoleChange open={confirm} onClose={() => setConfirm(false)} role={role} isNew={isNew} name={name} desc={desc} cells={cells} diff={diff} sensitive={sensAdded}
        onConflict={(c) => { setConfirm(false); setConflict(c); }}
        onSaved={(newId) => { setConfirm(false); if (isNew && newId) router.push(`/dashboard/employees/roles/${newId}`); else setReload((x) => x + 1); }} />
    </UsersFrame>
  );
}

function ConfirmRoleChange(props: Parameters<typeof ConfirmRoleChangeInner>[0]) {
  return props.open ? <ConfirmRoleChangeInner {...props} /> : null;
}

function ConfirmRoleChangeInner({ open, onClose, role, isNew, name, desc, cells, diff, sensitive, onSaved, onConflict }: {
  open: boolean; onClose: () => void; role: Role; isNew: boolean; name: string; desc: string; cells: Cells; diff: ReturnType<typeof changedCells>; sensitive: ReturnType<typeof changedCells>;
  onSaved: (id?: string) => void; onConflict: (c: Conflict) => void;
}) {
  const { lang, ar, L } = useLangL();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [simple, setSimple] = useState(true);
  const pc = usePasswordConfirm();
  useEffect(() => { void api<{ caps: { simpleMode: boolean } }>("/api/roles").then((r) => setSimple(r.data.caps?.simpleMode !== false)); }, []);
  const lvl = (v: string) => (ar ? { none: "لا وصول", view: "عرض", edit: "تعديل" } : { none: "No access", view: "View", edit: "Edit" })[v as "none"] ?? v;
  const names = role.membersList.map((m) => m.name);
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = isNew
      ? await api<{ id: string }>("/api/roles", { method: "POST", body: { name, description: desc, permissions: cells, reason } })
      : await api<{ id: string; updatedByName?: string; version?: number }>(`/api/roles/${role.id}`, { method: "PUT", body: { name, description: desc, permissions: cells, reason, version: role.version } });
    setBusy(false);
    if (!r.ok) {
      if (r.data.code === "ROLE_CONFLICT") { onConflict({ by: (r.data as { updatedByName?: string }).updatedByName ?? null, version: (r.data as { version?: number }).version ?? 0 }); return; }
      setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return;
    }
    onSaved(r.data.id);
  }
  const who = ar ? (names.length === 1 ? `مستخدم الدور، ${names[0]}` : names.length === 2 ? `مستخدمَي الدور، ${names[0]} و${names[1]}` : names.length ? `${names.length} مستخدمين في الدور` : "لا أحد بعد") : `${names.length} users of the role`;
  return (
    <Dialog open={open} onClose={onClose} title={isNew ? L(`إنشاء دور «${name}»؟`, `Create role “${name}”?`) : L(`حفظ تغييرات دور «${role.name}»؟`, `Save changes to “${role.nameEn}”?`)} className="ur-dlg" testId="ur-confirm-role"
      sub={isNew ? L("يبدأ الدور بلا مستخدمين؛ يُسند من صفحة كل مستخدم.", "The role starts with no users; assign it from each user's page.") : L(`يسري على ${who}، من طلب كل منهم التالي. استثناءاتهم تبقى كما هي.`, `Applies to ${who} from their next request. Their exceptions stay as they are.`)}
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} disabled={reason.trim().length < 3} onClick={go} data-testid="ur-confirm-role-go">{isNew ? L("إنشاء الدور", "Create role") : L("حفظ التغييرات", "Save changes")}</Btn></>}>
      {diff.length ? (
        <ul className="ur-changes" data-testid="ur-role-change-list">
          {diff.filter((c) => !sensitive.includes(c)).map((c) => c.sub
            ? <li key={c.key}>{c.to === "true" ? <Dot tone="success">{L("مضاف", "Added")}</Dot> : <Dot tone="warning">{L("أُزيل", "Removed")}</Dot>} · {moduleLabel(c.module, lang)}: {subLabel(c.module, c.sub, lang)}</li>
            : <li key={c.key}><Dot tone="info">{L("مستوى", "Level")}</Dot> · {moduleLabel(c.module, lang)}: {lvl(c.from)} ← {lvl(c.to)}</li>)}
        </ul>
      ) : null}
      {sensitive.length ? (
        <div className="ur-sens" data-testid="ur-role-sensitive">
          <b><SensFlag lang={lang} />{sensitive.length === 1 ? L("صلاحية حساسة مضافة", "Sensitive permission added") : L(`${sensitive.length} صلاحيات حساسة مضافة`, `${sensitive.length} sensitive permissions added`)}</b>
          {sensitive.map((c) => <label key={c.key} className="tl-check"><input type="checkbox" checked readOnly />{c.sub ? subLabel(c.module, c.sub, lang) : moduleLabel(c.module, lang)}</label>)}
          <p>{simple
            ? L("منح دائم عبر الدور: يسري فور الحفظ على مستخدمي الدور (وضع المالك الواحد: لا معتمد ثانٍ)، ويُسجَّل بسببه. راجعه دوريًا.", "A permanent grant through the role: it applies on save (single-owner mode: no second approver) and is recorded with its reason. Review it periodically.")
            : L("منح دائم عبر الدور: يتطلب اعتمادًا منفصلًا ومراجعة دورية وفق السياسة المعتمدة، ولا يسري قبل الاعتماد.", "A permanent grant through the role needs a separate approval and periodic review, and does not apply before approval.")}</p>
        </div>
      ) : null}
      <ReasonField value={reason} onChange={setReason} required testId="ur-confirm-role-reason" />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid="ur-confirm-role-error">{err}</div> : null}
    </Dialog>
  );
}
