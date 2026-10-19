"use client";
// Organisation settings — Direction 2.1 (UI batch 2; GX F-P01, Figma 1205:2 at 1440, EN 1212:90149,
// 1024 1205:393, phone 1212:2694).
//
// Visual port only. The same requests and rules as the legacy screen: the logo (GET/PUT
// /api/settings/logo, 2 MB limit), the cupping close minimum (E6, GET/PUT /api/settings/cupping,
// 2–20), the factory reset (POST /api/admin/reset) and the training-data reset (POST
// /api/admin/training-reset, only with settings.training_reset), each behind its phrase and PIN.
// The page stays admin-only. «الجلسات والأجهزة الموثوقة» is drawn as the frame does — approved
// Phase 7 design, not built — with nothing to open.
import { useState, useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/app/dashboard/user-context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { PIN_LENGTH } from "@/lib/pin-policy";
import { Btn, Field, Notice, OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { Ico } from "@/components/shell/icons";
import { routeAllowed } from "@/lib/nav/registry";
import { useD21Phone } from "@/components/shell/page-context";
import { Sec, SettingsFrame, useViewer } from "../_components/tools-ui";

export default function SettingsPage() {
  const { t } = useI18n();
  const L = useL();
  const router = useRouter();
  const user = useUser();
  const viewer = useViewer();
  useD21Phone({ title: L("المنشأة", "Organisation"), sub: L("الإعدادات", "Settings") });

  // ── Logo state ───────────────────────────────────────────────────────────────
  const [logoBase64, setLogoBase64] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoMsg, setLogoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/settings/logo")
      .then((r) => r.json())
      .then((d) => setLogoBase64(d.logoBase64 ?? null))
      .catch(() => {});
  }, []);

  // ── Cupping close policy (E6, admin only; the API enforces role and range) ──
  const [minScorers, setMinScorers] = useState("");
  const [cupSaving, setCupSaving] = useState(false);
  const [cupMsg, setCupMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/cupping")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.minScorers === "number") setMinScorers(String(d.minScorers)); })
      .catch(() => {});
  }, []);

  async function saveMinScorers(e: React.FormEvent) {
    e.preventDefault();
    const v = Number(minScorers);
    if (!/^\d+$/.test(minScorers.trim()) || v < 2 || v > 20) {
      setCupMsg({ ok: false, text: t("cuppingPolicyRange") });
      return;
    }
    setCupSaving(true);
    setCupMsg(null);
    try {
      const res = await fetch("/api/settings/cupping", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minScorers: v }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCupMsg({ ok: false, text: j.code === "CUPPING_MIN_SCORERS_OUT_OF_RANGE" ? t("cuppingPolicyRange") : t("cuppingPolicyError") });
        return;
      }
      setMinScorers(String(j.minScorers));
      setCupMsg({ ok: true, text: t("cuppingPolicySaved") });
    } catch {
      setCupMsg({ ok: false, text: t("cuppingPolicyError") });
    } finally {
      setCupSaving(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) fileInputRef.current = e.target;
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setLogoMsg({ ok: false, text: L("الملف أكبر من 2 ميغابايت.", "File too large. Max size is 2MB.") });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      setLogoUploading(true);
      setLogoMsg(null);
      try {
        const res = await fetch("/api/settings/logo", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ logoBase64: base64 }),
        });
        if (!res.ok) throw new Error("Upload failed");
        setLogoBase64(base64);
        setLogoMsg({ ok: true, text: L("تم تحديث الشعار.", "Logo updated successfully.") });
      } catch {
        setLogoMsg({ ok: false, text: L("تعذّر حفظ الشعار. حاول مرة أخرى.", "Failed to save logo. Try again.") });
      } finally {
        setLogoUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleRemoveLogo() {
    setLogoUploading(true);
    setLogoMsg(null);
    try {
      const res = await fetch("/api/settings/logo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoBase64: null }),
      });
      if (!res.ok) throw new Error();
      setLogoBase64(null);
      setLogoMsg({ ok: true, text: L("أُزيل الشعار وعاد الشعار الافتراضي.", "Logo removed. Default logo restored.") });
    } catch {
      setLogoMsg({ ok: false, text: L("تعذّرت إزالة الشعار.", "Failed to remove logo.") });
    } finally {
      setLogoUploading(false);
    }
  }

  // ── Production Reset state ───────────────────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [resetting, setResetting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const CONFIRM_PHRASE = t("confirmPhrase"); // "RESET HIQBAH"
  const phraseMatch = phrase === CONFIRM_PHRASE;

  // ── Training Reset state ──────────────────────────────────────────────────
  const TRAINING_PHRASE = t("trainingConfirmPhrase"); // "CLEAR DEMO DATA"
  const [trainModalOpen, setTrainModalOpen] = useState(false);
  const [trainPhrase, setTrainPhrase] = useState("");
  const [trainPin, setTrainPin] = useState("");
  const [trainBackupChecked, setTrainBackupChecked] = useState(false);
  const [trainResetting, setTrainResetting] = useState(false);
  const [trainMsg, setTrainMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const trainPhraseMatch = trainPhrase === TRAINING_PHRASE;

  function openModal() {
    setPhrase(""); setPin(""); setMsg(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (resetting) return;
    setModalOpen(false);
  }

  function openTrainModal() {
    setTrainPhrase(""); setTrainPin(""); setTrainBackupChecked(false); setTrainMsg(null);
    setTrainModalOpen(true);
  }

  function closeTrainModal() {
    if (trainResetting) return;
    setTrainModalOpen(false);
  }

  async function handleTrainingReset(e: React.FormEvent) {
    e.preventDefault();
    setTrainMsg(null);
    setTrainResetting(true);
    try {
      const res = await fetch("/api/admin/training-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase: trainPhrase, pin: trainPin }),
      });
      const text = await res.text();
      let data: { error?: string } = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
      if (!res.ok) {
        const msg =
          res.status === 400 ? t("wrongPhrase") :
          res.status === 401 ? t("invalidPin") :
          data.error ?? t("trainingResetError");
        throw new Error(msg);
      }
      setTrainMsg({ ok: true, text: t("trainingResetSuccess") });
      setTimeout(() => { window.location.href = "/dashboard"; }, 2500);
    } catch (err: unknown) {
      setTrainMsg({ ok: false, text: err instanceof Error ? err.message : t("trainingResetError") });
    } finally {
      setTrainResetting(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setResetting(true);
    try {
      const res = await fetch("/api/admin/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase, pin }),
      });
      const text = await res.text();
      let data: { error?: string } = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
      if (!res.ok) {
        const msg =
          res.status === 400 ? t("wrongPhrase") :
          res.status === 401 ? t("invalidPin") :
          data.error ?? t("resetError");
        throw new Error(msg);
      }
      setMsg({ ok: true, text: t("resetSuccess") });
      // Redirect to dashboard after brief success pause
      setTimeout(() => {
        window.location.href = "/dashboard";
      }, 2500);
    } catch (err: unknown) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t("resetError") });
    } finally {
      setResetting(false);
    }
  }

  // Only admin role can access this page
  if (user && user.role !== "admin") {
    return (
      <OpsRoot className="tl-root">
        <div className="hr-page">
          <div className="hr-state" role="status">
            <h3>{L("لا تملك صلاحية فتح هذه الصفحة", "Access denied")}</h3>
            <p className="hr-caption" style={{ margin: 0 }}>{L("هذه الصفحة للمدير فقط.", "This page is restricted to Admins only.")}</p>
            <Btn variant="primary" onClick={() => router.push("/dashboard")}>{t("dashboard")}</Btn>
          </div>
        </div>
      </OpsRoot>
    );
  }

  const canTrainingReset = !!user && hasSubPrivilege(user.permissions, "settings", "training_reset");
  const canUsers = !!viewer && routeAllowed(viewer, "/dashboard/employees");
  const msgNotice = (m: { ok: boolean; text: string } | null) =>
    m ? <div role={m.ok ? "status" : "alert"} className={`hr-notice tone-${m.ok ? "success" : "danger"}`}>{m.text}</div> : null;

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("المنشأة", "Organisation")} />
        <p className="tl-sub">{t("systemSettings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>

        <div>
          {/* Branding */}
          <Sec title={L("الشعار", "Logo")} caption={L("محفوظ فقط: الواجهة والمستندات تستخدم شعار هوية حِقبة المعتمد · لا يُطبع على الملصقات", "Stored only: the app and documents use the official Hiqbah brand logo · not printed on labels")} testId="logo-section">
            <div className="tl-logorow">
              <div className="tl-logo">
                {logoBase64 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoBase64} alt={L("الشعار", "Logo")} />
                ) : <span className="tl-ph" aria-hidden />}
              </div>
              <div className="hr-stack" style={{ gap: 8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml"
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
                <div className="tl-acts">
                  <Btn onClick={() => fileInputRef.current?.click()} busy={logoUploading}>{L("تغيير الشعار", "Change logo")}</Btn>
                  {logoBase64 ? <Btn variant="ghost" onClick={handleRemoveLogo} disabled={logoUploading}>{L("إزالة الشعار", "Remove logo")}</Btn> : null}
                </div>
                <span className="hr-caption">{L("PNG أو JPG أو SVG · حتى 2 ميغابايت · مربع يُفضَّل", "PNG, JPG or SVG · up to 2 MB · square preferred")}</span>
              </div>
            </div>
            {msgNotice(logoMsg)}
          </Sec>

          {/* Access and sessions */}
          <Sec title={L("الوصول والجلسات", "Access and sessions")} caption={L("تُدار في صفحاتها المعتمدة ولا تتكرر هنا", "Managed on their own approved pages, not repeated here")}>
            {canUsers ? (
              <div className="tl-card">
                <Ico name="users" />
                <div>
                  <strong>{L("المستخدمون والصلاحيات", "Users & permissions")}</strong>
                  <p>{L("الحسابات والوحدات والصلاحيات وطلبات الهوية", "Accounts, modules, permissions and identity requests")}</p>
                </div>
                <Link href="/dashboard/employees" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
              </div>
            ) : null}
            <div className="tl-card">
              <Ico name="phone" />
              <div>
                <strong>{L("أجهزتي وجلساتي", "My devices & sessions")}</strong>
                <p>{L("أجهزتك وجلساتك النشطة وإنهاؤها · في «ملفي الشخصي»", "Your devices and active sessions, and ending them · in «My profile»")}</p>
              </div>
              <Link href="/dashboard/profile?tab=devices" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
            </div>
          </Sec>

          {/* Cupping close policy (E6) */}
          <Sec title={t("cuppingPolicyTitle")} caption={t("cuppingPolicyDesc")} testId="cupping-policy">
            <form onSubmit={saveMinScorers} noValidate className="tl-acts" style={{ alignItems: "flex-end" }}>
              <Field label={t("cuppingPolicyLabel")}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={20}
                  step={1}
                  value={minScorers}
                  onChange={(e) => setMinScorers(e.target.value)}
                  className="hr-input"
                  style={{ width: 120 }}
                  data-testid="cupping-min-scorers"
                />
              </Field>
              <Btn type="submit" variant="primary" disabled={cupSaving || minScorers === ""} busy={cupSaving}>{t("cuppingPolicySave")}</Btn>
            </form>
            {msgNotice(cupMsg)}
          </Sec>

          {/* Administration tools (danger) */}
          <Sec title={L("أدوات الإدارة", "Administration tools")} caption={L("إجراءات لا تُعكس · تتطلب عبارة تأكيد ورمز المدير", "Irreversible actions · each needs a confirmation phrase and the admin PIN")} tone="danger">
            <div>
              <div className="tl-row">
                <div>
                  <strong>{t("factoryReset")}</strong>
                  <p>{t("resetDesc")}</p>
                </div>
                <Btn variant="danger" onClick={openModal} data-testid="factory-reset">{L("مسح البيانات التشغيلية", t("wipeData"))}</Btn>
              </div>
              {canTrainingReset ? (
                <div className="tl-row">
                  <div>
                    <strong>{t("trainingResetTitle")}</strong>
                    <p>{t("trainingResetSectionDesc")}</p>
                    <p>{L("يحذف: الطلبات والعملاء والدفعات والجودة والتسليم والمخزون والمشتريات والموردين والمنتجات · يحفظ: الموظفين والإعدادات", "Deletes: orders, customers, batches, QC records, deliveries, inventory, purchase records, suppliers, products and SKUs · Preserves: employees, system settings")}</p>
                  </div>
                  <Btn variant="danger" onClick={openTrainModal} data-testid="training-reset">{L("مسح بيانات التدريب", t("trainingResetBtn"))}</Btn>
                </div>
              ) : null}
            </div>
            <Notice tone="warning">
              {L(
                "تعمل هذه الأدوات فقط على قاعدة بيانات مصرّح بمسحها في إعداد الخادم (تدريب أو اختبار). على قاعدة الإنتاج يرفض الخادم الطلب ولا يتغير شيء.",
                "These tools only work on a database the server configuration allows to be wiped (training or test). On the production database the server refuses and nothing changes.",
              )}
            </Notice>
          </Sec>
        </div>
      </SettingsFrame>

      {/* Production Reset confirmation */}
      <Dialog
        open={modalOpen}
        title={t("resetConfirmTitle")}
        onClose={closeModal}
        testId="reset-dialog"
        actions={
          <>
            <Btn onClick={closeModal} disabled={resetting}>{t("cancel")}</Btn>
            <Btn variant="danger" type="submit" form="reset-form" disabled={!phraseMatch || !pin || resetting} busy={resetting}>{resetting ? t("loading") : t("confirm")}</Btn>
          </>
        }
      >
        <form id="reset-form" onSubmit={handleReset} className="hr-stack" style={{ gap: 14 }}>
          <Notice tone="danger">{t("resetConfirmDesc")}</Notice>
          <Field label={t("typeToConfirm")}>
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              aria-invalid={phrase !== "" && !phraseMatch ? true : undefined}
              className="hr-input"
              style={{ fontFamily: "var(--f-mono)" }}
            />
          </Field>
          <Field label={t("enterPinToConfirm")}>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              maxLength={PIN_LENGTH}
              required
              dir="ltr"
              className="hr-input"
              style={{ letterSpacing: "0.3em" }}
            />
          </Field>
          {msgNotice(msg)}
        </form>
      </Dialog>

      {/* Training Reset confirmation */}
      <Dialog
        open={trainModalOpen}
        title={t("trainingResetConfirmTitle")}
        onClose={closeTrainModal}
        testId="training-reset-dialog"
        actions={
          <>
            <Btn onClick={closeTrainModal} disabled={trainResetting}>{t("cancel")}</Btn>
            <Btn variant="danger" type="submit" form="training-reset-form" disabled={!trainBackupChecked || !trainPhraseMatch || !trainPin || trainResetting} busy={trainResetting}>{trainResetting ? t("loading") : t("confirm")}</Btn>
          </>
        }
      >
        <form id="training-reset-form" onSubmit={handleTrainingReset} className="hr-stack" style={{ gap: 14 }}>
          <Notice tone="warning">{t("trainingResetConfirmDesc")}</Notice>
          <label className="tl-check">
            <input type="checkbox" checked={trainBackupChecked} onChange={(e) => setTrainBackupChecked(e.target.checked)} />
            <span>{t("trainingBackupCheck")}</span>
          </label>
          <Field label={t("trainingPhraseToConfirm")}>
            <input
              type="text"
              value={trainPhrase}
              onChange={(e) => setTrainPhrase(e.target.value)}
              placeholder={TRAINING_PHRASE}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              aria-invalid={trainPhrase !== "" && !trainPhraseMatch ? true : undefined}
              className="hr-input"
              style={{ fontFamily: "var(--f-mono)" }}
            />
          </Field>
          <Field label={t("enterPinToConfirm")}>
            <input
              type="password"
              inputMode="numeric"
              value={trainPin}
              onChange={(e) => setTrainPin(e.target.value.replace(/\D/g, ""))}
              maxLength={PIN_LENGTH}
              required
              dir="ltr"
              className="hr-input"
              style={{ letterSpacing: "0.3em" }}
            />
          </Field>
          {msgNotice(trainMsg)}
        </form>
      </Dialog>
    </OpsRoot>
  );
}
