"use client";
// The confirming dialogs of the users area (Figma UR-04 credentials 603:3017 / 615:7001, UR-11 revoke
// 604:2961 / 616:7199, UR-09 «إضافة استثناء» → UR-10 616:7103, and the plain password confirmations
// of UR-02d). Each draws the reason and «كلمة مرورك» (J-4), confirms the password with the server,
// then sends the action; the server re-checks everything (admin role, step-up, not one's own
// account, last administrator). On a phone the kit's Dialog is a bottom sheet.
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/hr/ui";
import { Select } from "@/components/ui/Select";
import { PRINT_PHASE1_NOTE_ID, PrintPhase1Notice, usePrintCertified } from "@/components/print/Certification";
import { Btn } from "@/components/ops/ui";
import { GROUPS, isSensitive, moduleLabel, subLabel, subsOf } from "@/lib/users/catalog";
import { PasswordConfirmField, ReasonField, SensFlag, api, endOfDayRiyadh, errText, fmtDate, fmtTime, useLangL, usePasswordConfirm, type Lang } from "./shared";

function Radio({ on, title, sub, onClick, disabled, testId }: { on: boolean; title: string; sub: string; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <label className={`tl-radio${on ? " is-on" : ""}${disabled ? " is-off" : ""}`} data-testid={testId}>
      <input type="radio" checked={on} onChange={onClick} disabled={disabled} />
      <span><strong>{title}</strong><span>{sub}</span></span>
    </label>
  );
}

// ── UR-04 · بيانات الدخول ───────────────────────────────────────────────────────────────────────
export function CredentialsDialog(props: Parameters<typeof CredentialsDialogInner>[0]) {
  return props.open ? <CredentialsDialogInner {...props} /> : null;
}

function CredentialsDialogInner({ open, onClose, user, lock, onDone }: {
  open: boolean; onClose: () => void; user: { id: string; name: string; username: string | null }; lock: { attempts: number; since: string | null } | null;
  onDone: (r: { action: string; temporaryPassword?: string; expiresAt?: string; applied?: boolean; pendingApproval?: unknown }) => void;
}) {
  const { lang, L } = useLangL();
  const [action, setAction] = useState<"unlock" | "reset_password" | "reset_pin">(lock ? "unlock" : "reset_password");
  const [reason, setReason] = useState(L("طلب الموظف بعد التحقق من هويته", "The employee asked, after verifying their identity"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  const first = user.name.split(" ")[0];
  const lockText = lock ? L(`يعود الدخول بكلمة المرور الحالية. سبب القفل: ${lock.attempts} محاولات فاشلة${lock.since ? ` آخرها ${fmtTime(lock.since)}` : ""}.`, `Sign-in with the current password works again. Locked by ${lock.attempts} failed attempts.`) : L("الحساب غير مقفل الآن.", "The account is not locked now.");
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api<{ action: string; temporaryPassword?: string; expiresAt?: string; applied?: boolean; pendingApproval?: unknown }>(`/api/users/${user.id}/credentials`, { method: "POST", body: { action, reason } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر التنفيذ.", "Could not do it."))); return; }
    onDone(r.data);
  }
  const primary = action === "unlock" ? L("فتح القفل", "Unlock") : action === "reset_password" ? L("إعادة تعيين كلمة المرور", "Reset password") : L("إعادة تعيين رمز المحطة", "Reset station PIN");
  return (
    <Dialog open={open} onClose={onClose} title={L(`بيانات دخول ${user.name}`, `${user.name}'s credentials`)} sub={L("لا تُعرض كلمة المرور ولا الرمز الحاليان ولا يمكن قراءتهما.", "The current password and PIN are never shown and cannot be read.")} className="ur-dlg" testId="ur-credentials-dialog"
      actions={<><Btn onClick={onClose}>{L("تراجع", "Back")}</Btn><Btn variant="primary" busy={busy} onClick={go} disabled={reason.trim().length < 3} data-testid="ur-cred-go">{primary}</Btn></>}>
      <div className="tl-radios">
        <Radio on={action === "unlock"} onClick={() => setAction("unlock")} disabled={!lock || !user.username} title={L("فتح القفل", "Unlock")} sub={lockText} testId="ur-cred-unlock" />
        <Radio on={action === "reset_password"} onClick={() => setAction("reset_password")} title={L("إعادة تعيين كلمة المرور", "Reset password")} sub={L("تُولَّد كلمة مؤقتة تُعرض مرة واحدة، ويُطلب تغييرها عند أول دخول. تُنهى جلساته كلها.", "A temporary password is generated and shown once; it must be changed at first sign-in. All sessions end.")} testId="ur-cred-password" />
        <Radio on={action === "reset_pin"} onClick={() => setAction("reset_pin")} title={L("إعادة تعيين رمز المحطة", "Reset station PIN")} sub={L(`يُلغى الرمز الحالي، ويعيّن ${first} رمزًا جديدًا بعد التحقق من هويته.`, `The current PIN is cleared; ${first} sets a new one after confirming their identity.`)} testId="ur-cred-pin" />
      </div>
      <ReasonField value={reason} onChange={setReason} required testId="ur-cred-reason" options={[L("طلب الموظف بعد التحقق من هويته", "The employee asked, after verifying their identity"), L("نسي كلمة المرور", "Forgot the password"), L("اشتباه في تسرّب بيانات الدخول", "Suspected credential leak")]} />
      <PasswordConfirmField pc={pc} hint={L("لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Quick PIN and biometrics are not accepted.")} />
      {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
    </Dialog>
  );
}

/** UR-03e / UR-04 result: the temporary password, shown once. */
export function TempPasswordDialog({ open, onClose, name, username, password, expiresAt, pending, primaryLabel, onPrimary }: { open: boolean; onClose: () => void; name: string; username: string | null; password: string; expiresAt: string; pending?: boolean; primaryLabel: string; onPrimary: () => void }) {
  const { lang, L } = useLangL();
  const [handed, setHanded] = useState(false);
  const [copied, setCopied] = useState(false);
  // UR-03e «طباعة»: a plain-document print, gated like every other (Phase 1: printing is off).
  const printing = usePrintCertified();
  const [hours] = useState(() => Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3_600_000)));
  return (
    <Dialog open={open} onClose={() => { if (handed) onClose(); }} title={L(`أُنشئ حساب ${name}`, `${name}'s account`)} className="ur-dlg" testId="ur-temp-dialog"
      sub={L("تُعرض كلمة المرور المؤقتة الآن فقط ولا يمكن استرجاعها. سلّمها للموظف بطريقة آمنة؛ سيغيّرها عند أول دخول.", "The temporary password is shown now only and cannot be recovered. Hand it over safely; it is changed at first sign-in.")}
      actions={<><Btn disabled={printing !== true} aria-describedby={printing === true ? undefined : PRINT_PHASE1_NOTE_ID} onClick={() => { if (printing === true) window.print(); }}>{L("طباعة", "Print")}</Btn><Btn variant="primary" disabled={!handed} onClick={onPrimary} data-testid="ur-temp-done">{primaryLabel}</Btn></>}>
      <dl className="ur-cred">
        <dt>{L("اسم المستخدم", "Username")}</dt><dd><bdi dir="ltr" className="ur-latin">{username ?? "—"}</bdi></dd>
        <dt>{L("كلمة المرور المؤقتة", "Temporary password")}</dt>
        <dd><bdi dir="ltr" className="ur-code" data-testid="ur-temp-password">{password}</bdi><Btn variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(password); setCopied(true); } catch { setCopied(false); } }}>{copied ? L("نُسخت", "Copied") : L("نسخ", "Copy")}</Btn></dd>
        <dt>{L("تنتهي صلاحيتها", "Expires")}</dt><dd>{L(`بعد ${hours} ساعة إن لم تُستخدم`, `in ${hours} hours if unused`)} · {fmtDate(expiresAt, lang)}</dd>
      </dl>
      {pending ? <div className="hr-notice tone-warning">{L("يسري بعد اعتماد محرر حسابات آخر.", "Takes effect after another account editor approves.")}</div> : null}
      {printing === false ? <PrintPhase1Notice /> : null}
      <label className="tl-check"><input type="checkbox" checked={handed} onChange={(e) => setHanded(e.target.checked)} data-testid="ur-temp-handed" />{L("سلّمتُ بيانات الدخول للموظف", "I handed the credentials to the employee")}</label>
    </Dialog>
  );
}

// ── UR-11 · إيقاف الوصول ───────────────────────────────────────────────────────────────────────
export function RevokeDialog(props: Parameters<typeof RevokeDialogInner>[0]) {
  return props.open ? <RevokeDialogInner {...props} /> : null;
}

function RevokeDialogInner({ open, onClose, user, onDone }: { open: boolean; onClose: () => void; user: { id: string; name: string }; onDone: (deleted: boolean) => void }) {
  const { lang, L } = useLangL();
  const [mode, setMode] = useState<"deactivate" | "delete">("deactivate");
  const [check, setCheck] = useState<{ deletable: boolean; claims: { id: string; stationType: string; itemType: string; itemId: string }[] } | null>(null);
  const [claims, setClaims] = useState<"release" | "keep">("release");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  useEffect(() => {
    if (!open) return;
    void api<{ deletable: boolean; claims: { id: string; stationType: string; itemType: string; itemId: string }[] }>(`/api/users/${user.id}/revoke`).then((r) => r.ok && setCheck(r.data));
  }, [open, user.id]);
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = mode === "delete"
      ? await api(`/api/employees/${user.id}`, { method: "DELETE" })
      : await api(`/api/users/${user.id}/revoke`, { method: "POST", body: { reason, claims } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الإيقاف.", "Could not revoke."))); return; }
    onDone(mode === "delete");
  }
  const n = check?.claims.length ?? 0;
  return (
    <Dialog open={open} onClose={onClose} title={L(`إيقاف وصول ${user.name}؟`, `Revoke ${user.name}'s access?`)} className="ur-dlg" testId="ur-revoke-dialog"
      actions={<><Btn onClick={onClose}>{L("تراجع", "Back")}</Btn><Btn className="ur-danger-fill" busy={busy} disabled={reason.trim().length < 3} onClick={go} data-testid="ur-revoke-go">{mode === "delete" ? L("حذف الحساب", "Delete account") : L("إيقاف الوصول", "Revoke access")}</Btn></>}>
      <div className="tl-radios">
        <Radio on={mode === "deactivate"} onClick={() => setMode("deactivate")} title={L("إيقاف الحساب", "Deactivate the account")} sub={L("قابل للتراجع. يبقى السجل والملف كما هما.", "Reversible. The history and the record stay as they are.")} />
        <Radio on={mode === "delete"} onClick={() => setMode("delete")} disabled={!check?.deletable} title={L("حذف الحساب", "Delete the account")}
          sub={check && !check.deletable ? L("غير متاح: للحساب سجلات مرتبطة. يرفض الخادم الحذف.", "Not available: the account has linked records. The server refuses the deletion.") : L("نهائي. متاح فقط لحساب بلا سجلات مرتبطة.", "Final. Only for an account with no linked records.")} />
      </div>
      <div className="ur-hide-phone">
        <p className="ur-lbl" style={{ margin: "0 0 6px" }}>{L("ما سيحدث", "What happens")}</p>
        <ul className="ur-whatlist">
          <li>{L("ينتهي وصوله إلى النظام من الطلب التالي، وتُنهى جلساته كلها.", "Access ends from the next request, and every session ends.")}</li>
          <li>{L("تُنهى جلساته على كل الأجهزة فورًا؛ عليه الدخول من جديد إن أُعيد تفعيله.", "Sessions on every device end at once; a reactivated account signs in again.")}</li>
        </ul>
      </div>
      {n ? (
        <div className="ur-claims" data-testid="ur-revoke-claims">
          <b style={{ fontWeight: 600 }}>{L(n === 1 ? "لديه مهمة محجوزة في محطة" : n === 2 ? "لديه مهمتان محجوزتان في محطة" : `لديه ${n} مهام محجوزة في المحطات`, `${n} claimed station task(s)`)}</b>
          <div className="ur-radios">
            <label className="tl-check"><input type="radio" checked={claims === "release"} onChange={() => setClaims("release")} />{L("تحريرها للفريق", "Release to the team")}</label>
            <label className="tl-check"><input type="radio" checked={claims === "keep"} onChange={() => setClaims("keep")} />{L("إبقاؤها للمشرف", "Keep for the supervisor")}</label>
          </div>
        </div>
      ) : null}
      <ReasonField value={reason} onChange={setReason} required testId="ur-revoke-reason" options={[L("انتهاء العقد", "Contract ended"), L("إجازة طويلة", "Long leave"), L("اشتباه في استخدام الحساب", "Suspected misuse")]} />
      <PasswordConfirmField pc={pc} hint={L("لا يُقبل الرمز السريع ولا البيانات الحيوية.", "Quick PIN and biometrics are not accepted.")} />
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid="ur-revoke-error">{err}</div> : null}
    </Dialog>
  );
}

/** A reason and the password, then one request (reactivate, remove an exception, end sessions…). */
export function ConfirmDialog(props: Parameters<typeof ConfirmDialogInner>[0]) {
  return props.open ? <ConfirmDialogInner {...props} /> : null;
}

function ConfirmDialogInner({ open, onClose, title, sub, children, confirmLabel, danger, needReason = true, reasonOptions, run, testId }: {
  open: boolean; onClose: () => void; title: string; sub?: string; children?: React.ReactNode; confirmLabel: string; danger?: boolean; needReason?: boolean; reasonOptions?: string[];
  run: (reason: string) => Promise<{ ok: boolean; data: { error?: string; errorEn?: string } }>; testId?: string;
}) {
  const { lang, L } = useLangL();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  async function go() {
    setBusy(true); setErr(null);
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await run(reason.trim());
    setBusy(false);
    if (!r.ok) setErr(errText(r.data, lang, L("تعذّر التنفيذ.", "Could not do it.")));
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} sub={sub} className="ur-dlg" testId={testId}
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant={danger ? undefined : "primary"} className={danger ? "ur-danger-fill" : undefined} busy={busy} disabled={needReason && reason.trim().length < 3} onClick={go} data-testid={`${testId ?? "ur-confirm"}-go`}>{confirmLabel}</Btn></>}>
      {children}
      {needReason ? <ReasonField value={reason} onChange={setReason} required options={reasonOptions} testId={`${testId ?? "ur-confirm"}-reason`} /> : null}
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid={`${testId ?? "ur-confirm"}-error`}>{err}</div> : null}
    </Dialog>
  );
}

// ── UR-09 «إضافة استثناء» (→ UR-10 user confirm) ──────────────────────────────────────────────────
type Cells = Record<string, { access: string; sub: Record<string, boolean> }>;
export function AddOverrideDialog(props: Parameters<typeof AddOverrideDialogInner>[0]) {
  return props.open ? <AddOverrideDialogInner {...props} /> : null;
}

function AddOverrideDialogInner({ open, onClose, user, template, effective, simpleMode, onDone }: { open: boolean; onClose: () => void; user: { id: string; name: string }; template: Cells; effective: Cells; simpleMode: boolean; onDone: () => void }) {
  const { lang, L } = useLangL();
  const [cell, setCell] = useState("");
  const [value, setValue] = useState("");
  const [expiry, setExpiry] = useState("");
  const [permanent, setPermanent] = useState(false);
  const [review, setReview] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pc = usePasswordConfirm();
  const options = useMemo(() => GROUPS.flatMap((g) => g.modules.flatMap((m) => [
    { key: m, label: `${g.ar === moduleLabel(m, "ar") ? "" : `${lang === "ar" ? g.ar : g.en} · `}${moduleLabel(m, lang)}`, sens: isSensitive(m, null) },
    ...subsOf(m).map((s) => ({ key: `${m}.${s}`, label: `${moduleLabel(m, lang)} · ${subLabel(m, s, lang)}`, sens: isSensitive(m, s) })),
  ])), [lang]);
  const [m, s] = cell.split(".");
  const isModule = !!cell && s === undefined;
  const current = cell ? (isModule ? effective[m]?.access : String(!!effective[m]?.sub?.[s])) : "";
  const roleValue = cell ? (isModule ? template[m]?.access : String(!!template[m]?.sub?.[s])) : "";
  const sensitive = !!options.find((o) => o.key === cell)?.sens;
  const grant = cell && value && (isModule ? ["none", "view", "edit"].indexOf(value) > ["none", "view", "edit"].indexOf(roleValue) : value === "true" && roleValue === "false");
  const needsExpiry = sensitive && grant && !permanent;
  async function go() {
    setBusy(true); setErr(null);
    if (needsExpiry && !expiry) { setErr(L("مطلوب: الصلاحية الحساسة المؤقتة تتطلب تاريخ انتهاء.", "Required: a temporary sensitive permission needs an expiry date.")); setBusy(false); return; }
    if (!(await pc.confirm())) { setBusy(false); return; }
    const r = await api(`/api/users/${user.id}/overrides`, { method: "POST", body: { cell, value, reason, expiresAt: expiry ? endOfDayRiyadh(expiry) : null, permanent, reviewAt: permanent && review ? endOfDayRiyadh(review) : null } });
    setBusy(false);
    if (!r.ok) { setErr(errText(r.data, lang, L("تعذّر الحفظ.", "Could not save."))); return; }
    onDone();
  }
  return (
    <Dialog open={open} onClose={onClose} title={L(`حفظ صلاحيات ${user.name}؟`, `Save ${user.name}'s permissions?`)} sub={L("يسري من طلبه التالي.", "Applies from their next request.")} className="ur-dlg" testId="ur-override-dialog"
      actions={<><Btn onClick={onClose}>{L("رجوع", "Back")}</Btn><Btn variant="primary" busy={busy} disabled={!cell || !value || value === current || reason.trim().length < 3} onClick={go} data-testid="ur-override-go">{L("حفظ التغييرات", "Save changes")}</Btn></>}>
      <label className="hr-field">
        <span className="hr-label">{L("الصلاحية", "Permission")}</span>
        <Select value={cell} onChange={(e) => { setCell(e.target.value); setValue(""); }} data-testid="ur-override-cell">
          <option value="">{L("اختر…", "Choose…")}</option>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}{o.sens ? ` · ${L("حساس", "sensitive")}` : ""}</option>)}
        </Select>
      </label>
      {cell ? (
        <label className="hr-field">
          <span className="hr-label">{L("القيمة لهذا المستخدم", "Value for this user")}</span>
          <Select value={value} onChange={(e) => setValue(e.target.value)} data-testid="ur-override-value">
            <option value="">{L("اختر…", "Choose…")}</option>
            {(isModule ? ["none", "view", "edit"] : ["true", "false"]).map((v) => <option key={v} value={v} disabled={v === current}>{valueWord(v, lang)}{v === roleValue ? ` · ${L("قيمة الدور", "role value")}` : ""}</option>)}
          </Select>
          <span className="hr-help">{L(`الآن: ${valueWord(current, lang)} · الدور: ${valueWord(roleValue, lang)}`, `Now: ${valueWord(current, lang)} · Role: ${valueWord(roleValue, lang)}`)}</span>
        </label>
      ) : null}
      {sensitive ? <div className="ur-sensrow"><SensFlag lang={lang} /><span>{L("صلاحية حساسة: المؤقتة تتطلب تاريخ انتهاء، والدائمة تتطلب مراجعة دورية.", "Sensitive: a temporary grant needs an expiry; a permanent one needs a periodic review.")}</span></div> : null}
      <div className="ur-twocol">
        <label className="hr-field">
          <span className="hr-label">{L("انتهاء الاستثناء", "Exception expiry")}{needsExpiry ? <span className="ur-req"> *</span> : null}</span>
          <input className="hr-input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={permanent} data-testid="ur-override-expiry" />
        </label>
        {sensitive && grant ? (
          <label className="hr-field">
            <span className="hr-label">{L("مراجعة دورية (للدائم)", "Periodic review (permanent)")}</span>
            <input className="hr-input" type="date" value={review} onChange={(e) => setReview(e.target.value)} disabled={!permanent} />
          </label>
        ) : null}
      </div>
      {sensitive && grant ? (
        <label className="tl-check"><input type="checkbox" checked={permanent} onChange={(e) => { setPermanent(e.target.checked); if (e.target.checked) setExpiry(""); }} disabled={!simpleMode} />{L("منح دائم (يتطلب تاريخ مراجعة)", "Permanent grant (needs a review date)")}</label>
      ) : null}
      {sensitive && grant && !simpleMode ? <p className="hr-caption" style={{ margin: 0 }}>{L("المنح الحساس الدائم يتطلب اعتمادًا من مخوَّل غير طالب المنح. لا يسري قبل الاعتماد.", "A permanent sensitive grant needs approval by someone other than the requester.")}</p> : null}
      <ReasonField value={reason} onChange={setReason} required testId="ur-override-reason" />
      <PasswordConfirmField pc={pc} />
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid="ur-override-error">{err}</div> : null}
    </Dialog>
  );
}

export function valueWord(v: string, lang: Lang): string {
  const ar: Record<string, string> = { none: "لا وصول", view: "عرض", edit: "تعديل", true: "مسموح", false: "غير مسموح" };
  const en: Record<string, string> = { none: "No access", view: "View", edit: "Edit", true: "Allowed", false: "Not allowed" };
  return (lang === "ar" ? ar : en)[v] ?? "—";
}
