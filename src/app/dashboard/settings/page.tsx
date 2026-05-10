"use client";

import { useState, useEffect, useRef } from "react";
import { Settings, Trash2, AlertTriangle, CheckCircle, AlertCircle, X, ShieldOff, ImagePlus, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useRouter } from "next/navigation";
import { useUser } from "@/app/dashboard/layout";

export default function SettingsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const user = useUser();

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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) fileInputRef.current = e.target;
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setLogoMsg({ ok: false, text: "File too large. Max size is 2MB." });
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
        setLogoMsg({ ok: true, text: "Logo updated successfully." });
      } catch {
        setLogoMsg({ ok: false, text: "Failed to save logo. Try again." });
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
      setLogoMsg({ ok: true, text: "Logo removed. Default logo restored." });
    } catch {
      setLogoMsg({ ok: false, text: "Failed to remove logo." });
    } finally {
      setLogoUploading(false);
    }
  }

  // ── Reset state ──────────────────────────────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [resetting, setResetting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const CONFIRM_PHRASE = t("confirmPhrase"); // "RESET HIQBAH"
  const phraseMatch = phrase === CONFIRM_PHRASE;

  function openModal() {
    setPhrase(""); setPin(""); setMsg(null);
    setModalOpen(true);
  }

  function closeModal() {
    if (resetting) return;
    setModalOpen(false);
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
      <div className="flex flex-col items-center justify-center h-64 text-center gap-4">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
          <ShieldOff size={28} className="text-red-400" />
        </div>
        <div>
          <p className="text-lg font-bold text-charcoal">Access Denied</p>
          <p className="text-sm text-brown/60 mt-1">This page is restricted to Admins only.</p>
        </div>
        <button
          onClick={() => router.push("/dashboard")}
          className="mt-2 px-5 py-2 rounded-xl bg-orange text-white text-sm font-bold hover:bg-orange/90 transition-colors"
        >
          {t("dashboard")}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-3">
          <Settings className="text-orange" size={28} />
          {t("systemSettings")}
        </h1>
        <p className="text-brown text-sm mt-1">{t("settingsSubtitle")}</p>
      </div>

      {/* Branding */}
      <section className="bg-white rounded-2xl shadow-sm border border-border p-6">
        <h2 className="text-base font-bold text-charcoal mb-1 flex items-center gap-2">
          <ImagePlus size={18} className="text-orange" />
          الشعار / Logo
        </h2>
        <p className="text-sm text-brown/60 mb-5">Upload a custom logo (PNG, JPG, SVG — max 2 MB).</p>

        <div className="flex items-center gap-5 flex-wrap">
          {/* Preview */}
          <div className="w-20 h-20 rounded-xl border-2 border-dashed border-border bg-cream flex items-center justify-center overflow-hidden flex-shrink-0">
            {logoBase64 ? (
              <img src={logoBase64} alt="Logo" className="w-full h-full object-contain p-1" />
            ) : (
              <span className="text-[36px] leading-none" style={{ fontFamily: "'Scheherazade New','Amiri',serif", color: "#8B9DB5" }}>ح</span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={logoUploading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-orange text-white text-sm font-bold hover:bg-orange/90 transition-colors disabled:opacity-50"
            >
              {logoUploading ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
              تعديل الشعار / Upload Logo
            </button>
            {logoBase64 && (
              <button
                onClick={handleRemoveLogo}
                disabled={logoUploading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-border text-sm text-charcoal/60 hover:text-red-500 hover:border-red-300 transition-colors disabled:opacity-50"
              >
                <X size={14} />
                Remove Logo
              </button>
            )}
          </div>
        </div>

        {logoMsg && (
          <div className={`mt-4 flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl ${
            logoMsg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
          }`}>
            {logoMsg.ok ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
            {logoMsg.text}
          </div>
        )}
      </section>

      {/* Danger Zone */}
      <section className="bg-white rounded-2xl shadow-sm border border-red-200 p-6">
        <h2 className="text-base font-bold text-red-600 mb-1 flex items-center gap-2">
          <AlertTriangle size={18} />
          {t("dangerZone")}
        </h2>
        <p className="text-sm text-charcoal/60 mb-5">{t("resetDesc")}</p>

        <div className="flex items-center justify-between gap-4 bg-red-50 border border-red-200 rounded-xl px-5 py-4">
          <div>
            <p className="font-bold text-sm text-charcoal">{t("factoryReset")}</p>
            <p className="text-xs text-red-500 mt-0.5">{t("wipeData")}</p>
          </div>
          <button
            onClick={openModal}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-bold transition-colors flex-shrink-0"
          >
            <Trash2 size={16} />
            {t("wipeData")}
          </button>
        </div>
      </section>

      {/* Reset confirmation modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-red-50">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertTriangle size={20} className="text-red-600" />
                </div>
                <h3 className="font-extrabold text-charcoal text-base">{t("resetConfirmTitle")}</h3>
              </div>
              <button onClick={closeModal} className="text-charcoal/40 hover:text-charcoal transition-colors">
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleReset} className="px-6 py-5 space-y-5">
              {/* Warning */}
              <p className="text-sm text-red-600 font-medium bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                {t("resetConfirmDesc")}
              </p>

              {/* Phrase input */}
              <div>
                <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
                  {t("typeToConfirm")}
                </label>
                <input
                  type="text"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  placeholder={CONFIRM_PHRASE}
                  autoComplete="off"
                  spellCheck={false}
                  className={`w-full px-4 py-2.5 rounded-xl border bg-cream text-charcoal text-sm font-mono focus:outline-none focus:ring-2 ${
                    phrase
                      ? phraseMatch
                        ? "border-green-400 focus:ring-green-300"
                        : "border-red-300 focus:ring-red-200"
                      : "border-border focus:ring-orange/40"
                  }`}
                />
              </div>

              {/* PIN input */}
              <div>
                <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
                  {t("enterPinToConfirm")}
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  maxLength={8}
                  required
                  className="w-full px-4 py-2.5 rounded-xl border border-border bg-cream text-charcoal text-sm focus:outline-none focus:ring-2 focus:ring-orange/40 tracking-widest"
                />
              </div>

              {msg && (
                <div className={`flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl ${
                  msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
                }`}>
                  {msg.ok ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                  {msg.text}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={resetting}
                  className="flex-1 py-2.5 rounded-xl border border-border text-charcoal text-sm font-semibold hover:bg-cream transition-colors disabled:opacity-50"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!phraseMatch || !pin || resetting}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-bold transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {resetting ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      {t("loading")}
                    </>
                  ) : (
                    <>
                      <Trash2 size={15} />
                      {t("confirm")}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
