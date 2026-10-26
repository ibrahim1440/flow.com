"use client";
// Organisation settings — Direction 2.1 (UI batch 2; GX F-P01, Figma 1205:2 at 1440, EN 1212:90149,
// 1024 1205:393, phone 1212:2694).
//
// The same requests and rules as the legacy screen: the logo (GET/PUT /api/settings/logo, 2 MB
// limit), the cupping close minimum (E6, GET/PUT /api/settings/cupping, 2–20), the factory reset
// (POST /api/admin/reset) and the training-data reset (POST /api/admin/training-reset, only with
// settings.training_reset), each behind its phrase and PIN. The page stays admin-only.
// Batch "Settings" (frame parity): the logo states F-S1…F-S4 (uploading, too large with the size,
// wrong type, saved) and the remove confirmation F-02r; the reset dialogs F-03 / F-04 (deletes /
// keeps, «لا يمكن التراجع», the phrase and PIN hints, «مسح نهائي»), the refusal F-05 and the error
// states F-S5…F-S8; the non-admin state F-06; the phone layout F-01m (rows). The seller block and
// the cupping minimum are sections the frames predate (code additions, kept).
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
import { useD21Phone, usePhone } from "@/components/shell/page-context";
import { Sec, SettingsFrame, useViewer } from "../_components/tools-ui";
import "./_parts/sections.css";

export default function SettingsPage() {
  const { t } = useI18n();
  const L = useL();
  const router = useRouter();
  const user = useUser();
  const viewer = useViewer();
  const phone = usePhone();
  const [openRow, setOpenRow] = useState<string | null>(null);
  useD21Phone({ title: L("المنشأة", "Organisation"), sub: L("الإعدادات", "Settings") });

  // ── Logo state ───────────────────────────────────────────────────────────────
  const [logoBase64, setLogoBase64] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoMsg, setLogoMsg] = useState<{ ok: boolean; title?: string; text: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/settings/logo")
      .then((r) => r.json())
      .then((d) => setLogoBase64(d.logoBase64 ?? null))
      .catch(() => {});
  }, []);

  // ── The quotation document's seller block (batch "Sales", track A; GET/PUT /api/settings/quotation:
  //    admin role, step-up; each change audited in SalesQuoteAudit). Empty fields are not printed. ──
  const SELLER_KEYS = ["sellerLegalNameAr", "sellerLegalNameEn", "sellerAddressAr", "sellerAddressEn", "sellerVatNumber", "sellerCrNumber", "sellerPhone", "sellerBankName", "sellerBankAccountName", "sellerIban"] as const;
  type SellerKey = (typeof SELLER_KEYS)[number];
  const [seller, setSeller] = useState<Record<SellerKey, string>>(() => Object.fromEntries(SELLER_KEYS.map((k) => [k, ""])) as Record<SellerKey, string>);
  const [sellerSaving, setSellerSaving] = useState(false);
  const [sellerMsg, setSellerMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/settings/quotation")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.seller) setSeller(Object.fromEntries(SELLER_KEYS.map((k) => [k, d.seller[k] ?? ""])) as Record<SellerKey, string>); })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveSeller(e: React.FormEvent) {
    e.preventDefault();
    setSellerSaving(true);
    setSellerMsg(null);
    try {
      const res = await fetch("/api/settings/quotation", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seller) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setSellerMsg({ ok: false, text: L(j.error ?? "تعذّر الحفظ.", j.errorEn ?? j.error ?? "Could not save.") }); return; }
      setSeller(Object.fromEntries(SELLER_KEYS.map((k) => [k, j.seller?.[k] ?? ""])) as Record<SellerKey, string>);
      setSellerMsg({ ok: true, text: L("حُفظت بيانات المنشأة وستظهر في عروض الأسعار التي تصدر من الآن.", "Saved. Quotations issued from now on carry these details.") });
    } catch {
      setSellerMsg({ ok: false, text: L("تعذّر الحفظ.", "Could not save.") });
    } finally {
      setSellerSaving(false);
    }
  }

  // ── The sign-in line (owner language decision 1; GET/PUT /api/settings/login-tagline: admin role,
  //    step-up, audited in SettingsAuditLog). Empty = the built-in line of that language. ──
  type Tagline = { ar: string | null; en: string | null; effective: { ar: string; en: string }; limits: { max: number; defaults: { ar: string; en: string } } };
  const [tagline, setTagline] = useState<Tagline | null>(null);
  const [tagAr, setTagAr] = useState("");
  const [tagEn, setTagEn] = useState("");
  const [tagSaving, setTagSaving] = useState(false);
  const [tagMsg, setTagMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/settings/login-tagline", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Tagline | null) => { if (d) { setTagline(d); setTagAr(d.ar ?? ""); setTagEn(d.en ?? ""); } })
      .catch(() => {});
  }, []);
  async function saveTagline(e: React.FormEvent | null, values?: { taglineAr: string; taglineEn: string }) {
    e?.preventDefault();
    const body = values ?? { taglineAr: tagAr.trim(), taglineEn: tagEn.trim() };
    setTagSaving(true);
    setTagMsg(null);
    try {
      const res = await fetch("/api/settings/login-tagline", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setTagMsg({ ok: false, text: L(j.error ?? "تعذّر الحفظ. لم يتغير شيء.", j.errorEn ?? j.error ?? "Could not save. Nothing was changed.") }); return; }
      setTagline(j as Tagline);
      setTagAr(j.ar ?? "");
      setTagEn(j.en ?? "");
      setTagMsg({ ok: true, text: L("حُفظ. تعرض صفحة الدخول الشعار الجديد من الآن.", "Saved. The sign-in page shows the new line from now on.") });
    } catch {
      setTagMsg({ ok: false, text: L("تعذّر الحفظ. لم يتغير شيء.", "Could not save. Nothing was changed.") });
    } finally {
      setTagSaving(false);
    }
  }

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
    // F-S3 (proposed): the picker filters the type, but a dropped or renamed file can still arrive.
    if (!["image/png", "image/jpeg", "image/svg+xml"].includes(file.type)) {
      setLogoMsg({ ok: false, title: L("نوع الملف غير مدعوم", "File type not supported"), text: L("الصيغ المقبولة: PNG أو JPG أو SVG.", "Accepted: PNG, JPG or SVG.") });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    // F-S2: «الملف أكبر من 2 ميغابايت» with the size of the file chosen.
    if (file.size > 2 * 1024 * 1024) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setLogoMsg({ ok: false, title: L("الملف أكبر من 2 ميغابايت", "The file is larger than 2 MB"), text: L(`اختر صورة أصغر. الملف المختار ${mb}\u00a0ميغابايت.`, `Choose a smaller image. The selected file is ${mb}\u00a0MB.`) });
      if (fileInputRef.current) fileInputRef.current.value = "";
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
        setLogoMsg({ ok: true, text: L("حُدّث الشعار.", "Logo updated.") });
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
      setRemoveOpen(false);
    } catch {
      setLogoMsg({ ok: false, text: L("تعذّرت إزالة الشعار.", "Failed to remove logo.") });
    } finally {
      setLogoUploading(false);
    }
  }

  // ── The two resets (F-03 factory, F-04 training): one dialog each, the same states ──────────
  // F-S5 wrong phrase, F-S6 wrong PIN, F-S7 too many requests, F-05 refused by the server (this
  // database is not a disposable target — «لم يتغير شيء»), F-S8 done (training environment).
  type Kind = "factory" | "training";
  type ResetMsg = { ok: boolean; title: string; text: string; refused?: boolean };
  const PHRASE: Record<Kind, string> = { factory: t("confirmPhrase"), training: t("trainingConfirmPhrase") };
  const [open, setOpen] = useState<Kind | null>(null);
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [backup, setBackup] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<ResetMsg | null>(null);
  const phraseMatch = !!open && phrase === PHRASE[open];

  function openReset(k: Kind) {
    setPhrase(""); setPin(""); setBackup(false); setResetMsg(null);
    setOpen(k);
  }
  function closeReset() {
    if (resetting) return;
    setOpen(null);
  }

  async function runReset(e: React.FormEvent) {
    e.preventDefault();
    if (!open || resetting) return;
    setResetMsg(null);
    setResetting(true);
    try {
      const res = await fetch(open === "factory" ? "/api/admin/reset" : "/api/admin/training-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase, pin }),
      });
      const text = await res.text();
      let data: { error?: string; reason?: string } = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
      if (res.ok) {
        setResetMsg({ ok: true, title: "", text: L("تمت إعادة الضبط. يُعاد توجيهك إلى الرئيسية…", "Reset complete. Taking you to Home…") });
        setTimeout(() => { window.location.href = "/dashboard"; }, 2500);
        return;
      }
      if (res.status === 403 && data.reason) {
        setResetMsg({ ok: false, refused: true, title: L("لم يتغير شيء", "Nothing was changed"), text: L("قاعدة البيانات هذه ليست هدفًا مصرّحًا للمسح. هذا متوقع على قاعدة الإنتاج.", "This database is not an authorized reset target. This is expected on the production database.") });
      } else if (res.status === 400 && /phrase/i.test(data.error ?? "")) {
        setResetMsg({ ok: false, title: L("عبارة التأكيد غير صحيحة", "The confirmation phrase is incorrect"), text: L("اكتبها كما هي بالأحرف الكبيرة.", "Type it exactly, in capitals.") });
      } else if (res.status === 401 || res.status === 400) {
        setResetMsg({ ok: false, title: L("رمز الدخول غير صحيح", "Incorrect PIN"), text: L("لم يتغير شيء.", "Nothing was changed.") });
      } else if (res.status === 429) {
        setResetMsg({ ok: false, title: L("طلبات كثيرة", "Too many requests"), text: L("حاول لاحقًا. لم يتغير شيء.", "Try again later. Nothing was changed.") });
      } else {
        setResetMsg({ ok: false, title: open === "factory" ? t("resetError") : t("trainingResetError"), text: L("لم يتغير شيء.", "Nothing was changed.") });
      }
    } catch {
      setResetMsg({ ok: false, title: open === "factory" ? t("resetError") : t("trainingResetError"), text: L("لم يتغير شيء.", "Nothing was changed.") });
    } finally {
      setResetting(false);
    }
  }

  // F-06: somebody who is not an administrator.
  if (user && user.role !== "admin") {
    return (
      <OpsRoot className="tl-root">
        <div className="hr-page">
          <div className="hr-state" role="status" data-testid="settings-denied">
            <h3>{L("لا يمكنك فتح هذه الشاشة", "You cannot open this screen")}</h3>
            <p className="hr-caption" style={{ margin: 0 }}>{L("إعدادات النظام للمدير فقط. تواصل مع المسؤول إذا كنت بحاجة للوصول.", "System settings are for administrators only. Ask an administrator if you need access.")}</p>
            <Btn variant="primary" onClick={() => router.push("/dashboard")}>{t("dashboard")}</Btn>
          </div>
        </div>
      </OpsRoot>
    );
  }

  const canTrainingReset = !!user && hasSubPrivilege(user.permissions, "settings", "training_reset");
  const canUsers = !!viewer && routeAllowed(viewer, "/dashboard/employees");
  const msgNotice = (m: { ok: boolean; title?: string; text: string } | null, testId?: string) =>
    m ? (
      <div role={m.ok ? "status" : "alert"} className={`hr-notice tone-${m.ok ? "success" : "danger"}`} data-testid={testId}>
        {m.title ? <strong className="d21-bold" style={{ display: "block", color: m.ok ? undefined : "var(--status-danger)" }}>{m.title}</strong> : null}
        {m.text}
      </div>
    ) : null;

  // F-01m: on a phone the sections below the logo are rows that open (the frame's chevrons).
  const row = (key: string, title: string, sub: string, opts: { href?: string; danger?: boolean; testId?: string } = {}) => {
    const inner = (
      <>
        <span className="tl-mrow-text"><strong style={opts.danger ? { color: "var(--status-danger)" } : undefined}>{title}</strong><span>{sub}</span></span>
        <Ico name="chev" small />
      </>
    );
    return opts.href
      ? <Link key={key} href={opts.href} className="tl-mrow" data-testid={opts.testId}>{inner}</Link>
      : <button key={key} type="button" className="tl-mrow" aria-expanded={openRow === key} onClick={() => setOpenRow(openRow === key ? null : key)} data-testid={opts.testId}>{inner}</button>;
  };
  const shown = (key: string) => !phone || openRow === key;

  const logoTile = (
    <div className="tl-logo" aria-busy={logoUploading || undefined}>
      {logoUploading ? <span className="tl-spin" aria-label={L("يُرفع…", "Uploading…")} /> : logoBase64 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoBase64} alt={L("الشعار", "Logo")} />
      ) : <span className="tl-ph" aria-hidden />}
    </div>
  );
  const changeLogo = (
    <Btn size={phone ? "sm" : undefined} onClick={() => fileInputRef.current?.click()} disabled={logoUploading} data-testid="logo-change">
      {logoUploading ? L("يُرفع…", "Uploading…") : L("تغيير الشعار", "Change logo")}
    </Btn>
  );
  const fileInput = (
    <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/svg+xml" style={{ display: "none" }} onChange={handleFileChange} data-testid="logo-file" />
  );

  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("المنشأة", "Organisation")} />
        <p className="tl-sub">{t("systemSettings")}<span className="tl-sep">·</span>{L("للمدير فقط", "admins only")}</p>

        <div>
          {phone ? (
            <section className="tl-mlogo" data-testid="logo-section">
              {logoTile}
              <div className="hr-stack" style={{ gap: 6 }}>
                <strong>{L("الشعار", "Logo")}</strong>
                {fileInput}
                {changeLogo}
              </div>
              <div style={{ gridColumn: "1 / -1" }}>{msgNotice(logoMsg, "logo-msg")}</div>
            </section>
          ) : (
            <Sec title={L("الشعار", "Logo")} caption={L("محفوظ فقط: الواجهة والمستندات تستخدم شعار هوية حِقبة المعتمد · لا يُطبع على الملصقات", "Stored only: the app and documents use the official Hiqbah brand logo · not printed on labels")} testId="logo-section">
              <div className="tl-logorow">
                {logoTile}
                <div className="hr-stack" style={{ gap: 8 }}>
                  {fileInput}
                  <div className="tl-acts">
                    {changeLogo}
                    {logoBase64 ? <Btn variant="ghost" onClick={() => setRemoveOpen(true)} disabled={logoUploading} data-testid="logo-remove">{L("إزالة الشعار", "Remove logo")}</Btn> : null}
                  </div>
                  <span className="hr-caption">{L("PNG أو JPG أو SVG · حتى 2 ميغابايت · مربّع يُفضَّل", "PNG, JPG or SVG · up to 2 MB · square works best")}</span>
                </div>
              </div>
              {msgNotice(logoMsg, "logo-msg")}
            </Sec>
          )}

          {phone ? (
            <nav className="tl-mrows" aria-label={L("المنشأة", "Organisation")}>
              {canUsers ? row("users", L("المستخدمون والصلاحيات", "Users & permissions"), L("المرحلة 8 المعتمدة", "Approved Phase 8"), { href: "/dashboard/employees", testId: "row-users" }) : null}
              {row("sessions", L("الجلسات والأجهزة", "Sessions & devices"), L("أجهزتي وجلساتي · في «ملفي الشخصي»", "My devices and sessions · in «My profile»"), { href: "/dashboard/profile?tab=devices", testId: "row-sessions" })}
              {row("seller", L("بيانات المنشأة في المستندات", "Company details on documents"), L("تُطبع في عرض السعر", "Printed on the quotation"), { testId: "row-seller" })}
              {shown("seller") ? <div className="tl-mpanel">{sellerForm()}</div> : null}
              {row("tagline", L("شعار صفحة الدخول", "Sign-in page line"), L("بالعربية والإنجليزية", "In Arabic and English"), { testId: "row-tagline" })}
              {shown("tagline") ? <div className="tl-mpanel">{taglineForm()}</div> : null}
              {row("cupping", t("cuppingPolicyTitle"), L("إغلاق جلسات التذوق", "Closing cupping sessions"), { testId: "row-cupping" })}
              {shown("cupping") ? <div className="tl-mpanel">{cuppingForm()}</div> : null}
              {row("tools", L("أدوات الإدارة", "Administration tools"), L("إعادة الضبط · بيئة تدريب فقط", "Resets · training environment only"), { danger: true, testId: "row-tools" })}
              {shown("tools") ? <div className="tl-mpanel">{toolsBody()}</div> : null}
            </nav>
          ) : (
            <>
              {/* Access and sessions (F-01) */}
              <Sec title={L("الوصول والجلسات", "Access and sessions")} caption={L("تُدار في صفحاتها المعتمدة ولا تتكرر هنا", "Managed on their own approved pages, not repeated here")}>
                {canUsers ? (
                  <div className="tl-card">
                    <Ico name="users" />
                    <div>
                      <strong>{L("المستخدمون والصلاحيات", "Users & permissions")}</strong>
                      <p>{L("الأدوار والاستثناءات وسجل الصلاحيات · تصميم المرحلة 8 المعتمد", "Roles, overrides and the permission log · approved Phase 8 design")}</p>
                    </div>
                    <Link href="/dashboard/employees" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
                  </div>
                ) : null}
                <div className="tl-card">
                  <Ico name="phone" />
                  <div>
                    <strong>{L("الجلسات والأجهزة الموثوقة", "Sessions & trusted devices")}</strong>
                    <p>{L("أجهزتك وجلساتك النشطة وإنهاؤها · في «ملفي الشخصي»", "Your devices and active sessions, and ending them · in «My profile»")}</p>
                  </div>
                  <Link href="/dashboard/profile?tab=devices" className="hr-btn is-sm" style={{ textDecoration: "none" }}>{L("فتح", "Open")}</Link>
                </div>
              </Sec>

              {/* The seller block of the quotation document (code addition, batch "Sales") */}
              <Sec title={L("بيانات المنشأة في المستندات", "Company details on documents")} caption={L("الاسم النظامي والعنوان والرقم الضريبي والسجل التجاري وبيانات التحويل البنكي · تُطبع في عرض السعر وتُثبَّت عند الإصدار", "Legal name, address, VAT and CR numbers, bank transfer details · printed on the quotation, frozen at issue")} testId="seller-section">
                {sellerForm()}
              </Sec>

              {/* The sign-in line (owner language decision 1, code addition) */}
              <Sec title={L("شعار صفحة الدخول", "Sign-in page line")} caption={L("السطر تحت الشعار في صفحة الدخول · يظهر بلغة الصفحة · فارغ = النص الافتراضي", "The line under the brand on the sign-in page · shown in the page's language · empty = the default text")} testId="tagline-section">
                {taglineForm()}
              </Sec>

              {/* Cupping close policy (E6, code addition) */}
              <Sec title={t("cuppingPolicyTitle")} caption={t("cuppingPolicyDesc")} testId="cupping-policy">
                {cuppingForm()}
              </Sec>

              {/* Administration tools (danger) */}
              <Sec title={L("أدوات الإدارة", "Administration tools")} caption={L("إجراءات لا تُعكس · تتطلب عبارة تأكيد ورمز المدير", "Irreversible actions · each needs a confirmation phrase and the admin PIN")} tone="danger">
                {toolsBody()}
              </Sec>
            </>
          )}
        </div>
      </SettingsFrame>

      {/* F-02r: confirm before removing the logo (proposed in the frame). */}
      <Dialog
        open={removeOpen}
        title={L("إزالة الشعار؟", "Remove the logo?")}
        onClose={() => { if (!logoUploading) setRemoveOpen(false); }}
        testId="logo-remove-dialog"
        actions={<>
          <Btn onClick={() => setRemoveOpen(false)} disabled={logoUploading}>{L("رجوع", "Back")}</Btn>
          <Btn variant="danger" onClick={handleRemoveLogo} busy={logoUploading} data-testid="logo-remove-confirm">{L("إزالة الشعار", "Remove logo")}</Btn>
        </>}
      >
        <Notice tone="info">{L("يعود الشعار الافتراضي إلى صفحة الدخول والشريط الجانبي. يمكنك رفع شعار جديد في أي وقت.", "The default mark returns to the sign-in page and the sidebar. You can upload a new logo at any time.")}</Notice>
      </Dialog>

      {/* F-03 / F-04: the reset confirmation (F-03m: a sheet on a phone, the dialog's own phone form). */}
      <Dialog
        open={!!open}
        title={open === "training" ? L("تأكيد إعادة تعيين بيانات التدريب", "Confirm training data reset") : L("تأكيد إعادة ضبط المصنع", "Confirm factory reset")}
        sub={L("الإجراء يُسجَّل باسمك", "Recorded under your name")}
        onClose={closeReset}
        testId={open === "training" ? "training-reset-dialog" : "reset-dialog"}
        actions={
          <>
            <Btn onClick={closeReset} disabled={resetting}>{resetMsg?.refused ? L("إغلاق", "Close") : t("cancel")}</Btn>
            {resetMsg?.refused ? null : (
              <Btn variant="danger" type="submit" form="reset-form" disabled={!phraseMatch || pin.length !== PIN_LENGTH || (open === "training" && !backup) || resetting || !!resetMsg?.ok} busy={resetting} data-testid="reset-confirm">
                {L("مسح نهائي", "Wipe permanently")}
              </Btn>
            )}
          </>
        }
      >
        <form id="reset-form" onSubmit={runReset} className="hr-stack" style={{ gap: 14 }}>
          {resetMsg?.refused ? msgNotice(resetMsg, "reset-msg") : null}
          <dl className="tl-props">
            <dt>{L("يُحذف", "Deletes")}</dt>
            <dd>{open === "training" ? L("كل ما سبق + الموردون والمنتجات والأصناف", "All of the above + suppliers, products and SKUs") : L("الطلبات والعملاء والدفعات والجودة والتسليم والمخزون والمشتريات", "Orders, customers, batches, QC, deliveries, inventory, purchases")}</dd>
            <dt>{L("يبقى", "Keeps")}</dt>
            <dd>{open === "training" ? L("الموظفون والإعدادات", "Employees and settings") : L("الموظفون والموردون والمنتجات والإعدادات", "Employees, suppliers, catalog and settings")}</dd>
          </dl>
          <Notice tone="danger"><strong className="d21-bold">{L("لا يمكن التراجع.", "This cannot be undone.")}</strong> {L("لا توجد استعادة من داخل النظام.", "There is no restore inside the system.")}</Notice>
          {open === "training" ? (
            <label className="tl-check">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} data-testid="reset-backup" />
              <span>{L("أؤكد وجود نسخة احتياطية حديثة من قاعدة البيانات.", "I confirm a current backup of the database exists.")}</span>
            </label>
          ) : null}
          <Field label={`${L(`اكتب ${open ? PHRASE[open] : ""} للتأكيد`, `Type ${open ? PHRASE[open] : ""} to confirm`)} *`} help={L("العبارة نفسها بالحروف اللاتينية في اللغتين", "The same Latin phrase in both languages")}>
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={open ? PHRASE[open] : ""}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              aria-invalid={phrase !== "" && !phraseMatch ? true : undefined}
              className="hr-input"
              style={{ fontFamily: "var(--f-mono)" }}
              data-testid="reset-phrase"
            />
          </Field>
          <Field label={`${L("رمز المدير", "Admin PIN")} *`} help={L(`رمزك أنت · ${PIN_LENGTH} أرقام`, `Your own PIN · ${PIN_LENGTH} digits`)}>
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
              data-testid="reset-pin"
            />
          </Field>
          {resetMsg && !resetMsg.refused ? msgNotice(resetMsg, "reset-msg") : null}
        </form>
      </Dialog>
    </OpsRoot>
  );

  function sellerForm() {
    return (
      <>
        <form onSubmit={saveSeller} noValidate className="hr-form">
          <Field label={L("الاسم النظامي (عربي)", "Legal name (Arabic)")}>
            <input className="hr-input" value={seller.sellerLegalNameAr} maxLength={160} onChange={(e) => setSeller({ ...seller, sellerLegalNameAr: e.target.value })} data-testid="seller-name-ar" />
          </Field>
          <Field label={L("الاسم النظامي (إنجليزي)", "Legal name (English)")}>
            <input className="hr-input" dir="ltr" value={seller.sellerLegalNameEn} maxLength={160} onChange={(e) => setSeller({ ...seller, sellerLegalNameEn: e.target.value })} data-testid="seller-name-en" />
          </Field>
          <Field label={L("العنوان (عربي)", "Address (Arabic)")}>
            <input className="hr-input" value={seller.sellerAddressAr} maxLength={300} onChange={(e) => setSeller({ ...seller, sellerAddressAr: e.target.value })} data-testid="seller-address-ar" />
          </Field>
          <Field label={L("العنوان (إنجليزي)", "Address (English)")}>
            <input className="hr-input" dir="ltr" value={seller.sellerAddressEn} maxLength={300} onChange={(e) => setSeller({ ...seller, sellerAddressEn: e.target.value })} data-testid="seller-address-en" />
          </Field>
          <Field label={L("الرقم الضريبي", "VAT number")} help={L("15 رقمًا يبدأ وينتهي بـ 3", "15 digits, starting and ending with 3")}>
            <input className="hr-input" dir="ltr" inputMode="numeric" value={seller.sellerVatNumber} maxLength={40} onChange={(e) => setSeller({ ...seller, sellerVatNumber: e.target.value })} data-testid="seller-vat" />
          </Field>
          {/* A5 (owner, 24 Oct 2026): this field holds the MoC UNIFIED national number (700…, e.g. 7029175754) — the seller's
              CRN on every invoice (ZATCA PartyIdentification schemeID="CRN"); the old CR number is also valid but not used. */}
          <Field label={L("الرقم الوطني الموحد (السجل التجاري)", "Unified national number (CR)")} help={L("10 أرقام — الرقم الموحد من وزارة التجارة (يبدأ بـ 7)، ويُطبع على الفواتير كرقم السجل", "10 digits — the MoC unified number (starts with 7), printed on invoices as the CR")}>
            <input className="hr-input" dir="ltr" inputMode="numeric" value={seller.sellerCrNumber} maxLength={40} onChange={(e) => setSeller({ ...seller, sellerCrNumber: e.target.value })} data-testid="seller-cr" />
          </Field>
          <Field label={L("الهاتف", "Phone")}>
            <input className="hr-input" dir="ltr" value={seller.sellerPhone} maxLength={40} onChange={(e) => setSeller({ ...seller, sellerPhone: e.target.value })} data-testid="seller-phone" />
          </Field>
          {/* «بيانات التحويل البنكي» on the quotation: printed only when filled. */}
          <p className="is-wide" style={{ margin: "8px 0 0", fontWeight: 500 }} data-testid="seller-bank-heading">
            {L("بيانات التحويل البنكي", "Bank transfer details")}
            <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{L(" · تُطبع في عرض السعر عند تعبئتها", " · printed on the quotation when filled in")}</span>
          </p>
          <Field label={L("البنك", "Bank")}>
            <input className="hr-input" value={seller.sellerBankName} maxLength={120} onChange={(e) => setSeller({ ...seller, sellerBankName: e.target.value })} data-testid="seller-bank-name" />
          </Field>
          <Field label={L("اسم الحساب", "Account name")}>
            <input className="hr-input" value={seller.sellerBankAccountName} maxLength={160} onChange={(e) => setSeller({ ...seller, sellerBankAccountName: e.target.value })} data-testid="seller-bank-account" />
          </Field>
          <Field label={L("رقم الآيبان", "IBAN")} help={L("SA ثم 22 رقمًا · المسافات مسموحة", "SA, then 22 digits · spaces allowed")}>
            <input className="hr-input" dir="ltr" style={{ fontFamily: "var(--f-mono)" }} value={seller.sellerIban} maxLength={60} autoComplete="off" spellCheck={false} placeholder="SA…" onChange={(e) => setSeller({ ...seller, sellerIban: e.target.value })} data-testid="seller-iban" />
          </Field>
          <div className="is-wide tl-acts">
            <Btn type="submit" variant="primary" disabled={sellerSaving} busy={sellerSaving} data-testid="seller-save">{L("حفظ بيانات المنشأة", "Save company details")}</Btn>
          </div>
        </form>
        {msgNotice(sellerMsg)}
      </>
    );
  }

  function taglineForm() {
    const max = tagline?.limits.max ?? 120;
    const defaults = tagline?.limits.defaults;
    const custom = !!(tagline?.ar || tagline?.en);
    const count = (v: string) => [...v.trim()].length;
    return (
      <>
        <form onSubmit={(e) => void saveTagline(e)} noValidate className="hr-form">
          <Field label={L("النص العربي", "Arabic text")} help={L(`حتى ${max} حرفًا · فارغ = «${defaults?.ar ?? ""}»`, `Up to ${max} characters · empty = «${defaults?.ar ?? ""}»`)}>
            <input className="hr-input" dir="rtl" lang="ar" value={tagAr} maxLength={max + 20} placeholder={defaults?.ar} onChange={(e) => setTagAr(e.target.value)} aria-invalid={count(tagAr) > max || undefined} data-testid="tagline-ar" />
          </Field>
          <Field label={L("النص الإنجليزي", "English text")} help={L(`حتى ${max} حرفًا · فارغ = «${defaults?.en ?? ""}»`, `Up to ${max} characters · empty = “${defaults?.en ?? ""}”`)}>
            <input className="hr-input" dir="ltr" lang="en" value={tagEn} maxLength={max + 20} placeholder={defaults?.en} onChange={(e) => setTagEn(e.target.value)} aria-invalid={count(tagEn) > max || undefined} data-testid="tagline-en" />
          </Field>
          <div className="is-wide tl-acts">
            <Btn type="submit" variant="primary" disabled={tagSaving || !tagline || count(tagAr) > max || count(tagEn) > max} busy={tagSaving} data-testid="tagline-save">{L("حفظ الشعار", "Save the line")}</Btn>
            {custom ? <Btn variant="ghost" disabled={tagSaving} onClick={() => void saveTagline(null, { taglineAr: "", taglineEn: "" })} data-testid="tagline-reset">{L("العودة إلى الافتراضي", "Back to the default")}</Btn> : null}
          </div>
        </form>
        {msgNotice(tagMsg, "tagline-msg")}
      </>
    );
  }

  function cuppingForm() {
    return (
      <>
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
      </>
    );
  }

  function toolsBody() {
    return (
      <>
        <div>
          <div className="tl-row">
            <div>
              <strong>{t("factoryReset")}</strong>
              <p>{L("يمسح كل البيانات التشغيلية · يحفظ الموظفين والموردين والمنتجات والإعدادات", "Wipes all operational data · keeps employees, suppliers, catalog and settings")}</p>
            </div>
            <Btn variant="danger" onClick={() => openReset("factory")} data-testid="factory-reset">{L("مسح البيانات التشغيلية", "Wipe operational data")}</Btn>
          </div>
          {canTrainingReset ? (
            <div className="tl-row">
              <div>
                <strong>{t("trainingResetTitle")}</strong>
                <p>{L("يحذف الطلبات والعملاء والدفعات والجودة والتسليم والمخزون والمشتريات والموردين والمنتجات · يحفظ الموظفين والإعدادات", "Deletes orders, customers, batches, QC, deliveries, inventory, purchases, suppliers and products · keeps employees and settings")}</p>
              </div>
              <Btn variant="danger" onClick={() => openReset("training")} data-testid="training-reset">{L("مسح بيانات التدريب", "Clear training data")}</Btn>
            </div>
          ) : null}
        </div>
        <Notice tone="warning">
          {L(
            "تعمل هذه الأدوات فقط على قاعدة بيانات مصرّح بمسحها في إعداد الخادم (تدريب أو اختبار). على قاعدة الإنتاج يرفض الخادم الطلب ولا يتغير شيء.",
            "These tools only work on a database the server configuration allows to be wiped (training or test). On the production database the server refuses and nothing changes.",
          )}
        </Notice>
      </>
    );
  }
}
