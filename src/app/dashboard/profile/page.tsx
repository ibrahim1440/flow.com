"use client";

import { useState, useEffect } from "react";
import { UserCircle, Phone, Globe, Lock, CheckCircle, AlertCircle, Eye, EyeOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useUser } from "@/app/dashboard/layout";

export default function ProfilePage() {
  const { t, lang } = useI18n();
  const user = useUser();

  // ── Personal info ──────────────────────────────────────────────────────────
  const [phoneNumber, setPhoneNumber] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<"ar" | "en">("ar");
  const [infoSaving, setInfoSaving] = useState(false);
  const [infoMsg, setInfoMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── PIN change ─────────────────────────────────────────────────────────────
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pinSaving, setPinSaving] = useState(false);
  const [pinMsg, setPinMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Pre-fill from profile API
  useEffect(() => {
    fetch("/api/profile")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!d) return;
        if (d.phoneNumber !== undefined) setPhoneNumber(d.phoneNumber ?? "");
        if (d.preferredLanguage) setPreferredLanguage(d.preferredLanguage);
      })
      .catch(() => {/* silently ignore prefill errors */});
  }, []);

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault();
    setInfoSaving(true);
    setInfoMsg(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber, preferredLanguage }),
      });
      // Safely parse — guard against empty / non-JSON responses
      const text = await res.text();
      let data: { error?: string; success?: boolean } = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* ignore parse error */ }

      if (!res.ok) throw new Error(data.error ?? t("error"));
      setInfoMsg({ ok: true, text: t("profileSaved") });
      // Full reload so the root layout picks up the new JWT lang/dir
      if (preferredLanguage !== lang) {
        setTimeout(() => window.location.reload(), 600);
      }
    } catch (err: unknown) {
      setInfoMsg({ ok: false, text: err instanceof Error ? err.message : t("error") });
    } finally {
      setInfoSaving(false);
    }
  }

  async function savePin(e: React.FormEvent) {
    e.preventDefault();
    setPinMsg(null);
    if (newPin !== confirmPin) {
      setPinMsg({ ok: false, text: t("pinMismatch") });
      return;
    }
    setPinSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin, newPin }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          res.status === 401 ? t("wrongCurrentPin") :
          res.status === 409 ? t("pinTaken") :
          data.error ?? t("error");
        throw new Error(msg);
      }
      setPinMsg({ ok: true, text: t("pinUpdated") });
      setCurrentPin(""); setNewPin(""); setConfirmPin("");
    } catch (err: unknown) {
      setPinMsg({ ok: false, text: err instanceof Error ? err.message : t("error") });
    } finally {
      setPinSaving(false);
    }
  }

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-3">
          <UserCircle className="text-orange" size={28} />
          {t("myProfile")}
        </h1>
        <p className="text-brown text-sm mt-1">{t("profileSubtitle")}</p>
      </div>

      {/* Personal Information */}
      <section className="bg-white rounded-2xl shadow-sm border border-border p-6">
        <h2 className="text-base font-bold text-charcoal mb-5 flex items-center gap-2">
          <Globe size={18} className="text-orange" />
          {t("personalInfo")}
        </h2>

        <form onSubmit={saveInfo} className="space-y-5">
          {/* Display Name (read-only) */}
          <div>
            <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
              {t("displayName")}
            </label>
            <input
              type="text"
              value={user.name}
              disabled
              className="w-full px-4 py-2.5 rounded-xl border border-border bg-cream text-charcoal/50 text-sm cursor-not-allowed"
            />
          </div>

          {/* Phone Number */}
          <div>
            <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
              {t("phoneNumber")}
            </label>
            <div className="relative">
              <Phone size={16} className="absolute top-1/2 -translate-y-1/2 ltr:left-3 rtl:right-3 text-brown/50" />
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder={t("phonePlaceholder")}
                className="w-full ltr:pl-9 rtl:pr-9 pr-4 pl-4 py-2.5 rounded-xl border border-border bg-cream text-charcoal text-sm focus:outline-none focus:ring-2 focus:ring-orange/40"
              />
            </div>
          </div>

          {/* Language */}
          <div>
            <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
              {t("language")}
            </label>
            <div className="flex gap-3">
              {(["ar", "en"] as const).map((lng) => (
                <button
                  key={lng}
                  type="button"
                  onClick={() => setPreferredLanguage(lng)}
                  className={`flex-1 py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                    preferredLanguage === lng
                      ? "bg-orange text-white border-orange shadow-sm"
                      : "border-border text-charcoal bg-cream hover:border-orange/40"
                  }`}
                >
                  {lng === "ar" ? "العربية" : "English"}
                </button>
              ))}
            </div>
          </div>

          {infoMsg && (
            <div className={`flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl ${
              infoMsg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
            }`}>
              {infoMsg.ok ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
              {infoMsg.text}
            </div>
          )}

          <button
            type="submit"
            disabled={infoSaving}
            className="w-full py-2.5 rounded-xl bg-orange text-white font-bold text-sm hover:bg-orange/90 disabled:opacity-60 transition-colors"
          >
            {infoSaving ? t("saving") : t("save")}
          </button>
        </form>
      </section>

      {/* Change PIN */}
      <section className="bg-white rounded-2xl shadow-sm border border-border p-6">
        <h2 className="text-base font-bold text-charcoal mb-5 flex items-center gap-2">
          <Lock size={18} className="text-orange" />
          {t("changePin")}
        </h2>

        <form onSubmit={savePin} className="space-y-4">
          {/* Current PIN */}
          <div>
            <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
              {t("currentPin")}
            </label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                inputMode="numeric"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
                maxLength={8}
                required
                className="w-full ltr:pr-10 rtl:pl-10 px-4 py-2.5 rounded-xl border border-border bg-cream text-charcoal text-sm focus:outline-none focus:ring-2 focus:ring-orange/40 tracking-widest"
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute top-1/2 -translate-y-1/2 ltr:right-3 rtl:left-3 text-brown/50 hover:text-brown"
              >
                {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* New PIN */}
          <div>
            <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
              {t("newPin")}
            </label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                inputMode="numeric"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                maxLength={8}
                minLength={4}
                required
                className="w-full ltr:pr-10 rtl:pl-10 px-4 py-2.5 rounded-xl border border-border bg-cream text-charcoal text-sm focus:outline-none focus:ring-2 focus:ring-orange/40 tracking-widest"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute top-1/2 -translate-y-1/2 ltr:right-3 rtl:left-3 text-brown/50 hover:text-brown"
              >
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Confirm PIN */}
          <div>
            <label className="block text-xs font-semibold text-brown uppercase tracking-wide mb-1.5">
              {t("confirmNewPin")}
            </label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                inputMode="numeric"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                maxLength={8}
                required
                className={`w-full ltr:pr-10 rtl:pl-10 px-4 py-2.5 rounded-xl border bg-cream text-charcoal text-sm focus:outline-none focus:ring-2 focus:ring-orange/40 tracking-widest ${
                  confirmPin && confirmPin !== newPin ? "border-red-400" : "border-border"
                }`}
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute top-1/2 -translate-y-1/2 ltr:right-3 rtl:left-3 text-brown/50 hover:text-brown"
              >
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {confirmPin && confirmPin !== newPin && (
              <p className="text-red-500 text-xs mt-1">{t("pinMismatch")}</p>
            )}
          </div>

          {pinMsg && (
            <div className={`flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl ${
              pinMsg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
            }`}>
              {pinMsg.ok ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
              {pinMsg.text}
            </div>
          )}

          <button
            type="submit"
            disabled={pinSaving || (!!confirmPin && confirmPin !== newPin)}
            className="w-full py-2.5 rounded-xl bg-orange text-white font-bold text-sm hover:bg-orange/90 disabled:opacity-60 transition-colors"
          >
            {pinSaving ? t("saving") : t("changePin")}
          </button>
        </form>
      </section>
    </div>
  );
}
