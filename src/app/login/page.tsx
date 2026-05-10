"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Delete, ArrowRight, Eye, EyeOff } from "lucide-react";

type Mode = "pin" | "password";

// PINs of exactly this length trigger auto-submit.
// Employees with longer PINs use the → button instead.
const PIN_AUTO_SUBMIT_LENGTH = 4;
const PIN_MAX_LENGTH = 8;

export default function LoginPage() {
  const [logoBase64, setLogoBase64] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("pin");
  const [pin, setPin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // ── Core submit ──────────────────────────────────────────────────────────────
  async function safeJson(res: Response) {
    try { return await res.json(); } catch { return null; }
  }

  const submitPin = useCallback(async (pinValue: string) => {
    if (!pinValue || loading) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "pin", pin: pinValue }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Login failed");
      router.push(data?.redirectTo ?? "/dashboard");
    } catch (err: unknown) {
      setPin("");
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }, [loading, router]);

  const submitPassword = useCallback(async () => {
    if (!username.trim() || !password || loading) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "password", username: username.trim(), password }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Login failed");
      router.push(data?.redirectTo ?? "/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }, [username, password, loading, router]);

  // ── Fetch logo ───────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/settings/logo")
      .then((r) => r.json())
      .then((d) => setLogoBase64(d.logoBase64 ?? null))
      .catch(() => {});
  }, []);

  // ── Auto-submit when PIN hits the magic length ────────────────────────────
  useEffect(() => {
    if (mode !== "pin" || pin.length !== PIN_AUTO_SUBMIT_LENGTH) return;
    // Small delay so the last dot renders visibly before the network call fires
    const t = setTimeout(() => submitPin(pin), 300);
    return () => clearTimeout(t);
  }, [pin, mode, submitPin]);

  // ── Numpad handlers ──────────────────────────────────────────────────────────
  function pressKey(key: string) {
    if (loading) return;
    if (key === "backspace") {
      setPin((p) => p.slice(0, -1));
      setError("");
    } else if (pin.length < PIN_MAX_LENGTH) {
      setPin((p) => p + key);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPin("");
    setPassword("");
    setError("");
  }

  const numpadRows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["backspace", "0", "submit"],
  ];

  return (
    <div className="min-h-screen flex items-center justify-center bg-charcoal p-4 relative overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      <div className="w-full max-w-sm relative z-10">
        <div className="bg-white rounded-2xl shadow-2xl shadow-black/30 p-7">

          {/* Logo */}
          <div className="text-center mb-7">
            <div className="flex flex-col items-center mb-3">
              {logoBase64 ? (
                <img src={logoBase64} alt="Logo" className="w-20 h-20 object-contain mx-auto" />
              ) : (
                <>
                  <span
                    className="text-[72px] leading-none"
                    style={{ fontFamily: "'Scheherazade New', 'Amiri', 'Noto Naskh Arabic', serif", color: "#8B9DB5" }}
                  >ح</span>
                  <span className="block w-10 h-[5px] rounded-full mt-3" style={{ backgroundColor: "#E25D2F", transform: "rotate(-8deg)" }} />
                </>
              )}
            </div>
            <h1 className="text-lg font-bold text-charcoal/80" style={{ fontFamily: "'Scheherazade New', 'Amiri', serif" }}>مقهى و محمصة حقبة</h1>
            <p className="text-[11px] tracking-[3px] text-brown/50 mt-0.5 uppercase">HIQBAH COFFEE ROASTERS</p>
          </div>

          {mode === "pin" ? (
            <>
              {/* PIN dot display */}
              <div className="mb-4">
                <label className="block text-xs font-bold text-brown uppercase tracking-wider mb-1.5 text-center">
                  Enter Your PIN
                </label>
                <div className="flex items-center justify-center gap-4 px-4 py-5 bg-cream rounded-xl border-2 border-border min-h-[68px]">
                  {pin.length === 0 ? (
                    <span className="text-brown/35 text-sm select-none">Tap the keypad below</span>
                  ) : (
                    Array.from({ length: pin.length }).map((_, i) => (
                      <div
                        key={i}
                        className={`w-3.5 h-3.5 rounded-full transition-all duration-150 ${
                          i === pin.length - 1 ? "bg-orange scale-110" : "bg-charcoal"
                        }`}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Error (inline so layout doesn't shift) */}
              {error && (
                <div className="bg-danger-bg text-danger px-4 py-2.5 rounded-xl text-sm font-semibold mb-4 text-center">
                  {error}
                </div>
              )}

              {/* Numpad */}
              <div dir="ltr" className="grid grid-cols-3 gap-2.5 mb-5">
                {numpadRows.flat().map((key) => {
                  if (key === "backspace") {
                    return (
                      <button
                        key="backspace"
                        type="button"
                        onClick={() => pressKey("backspace")}
                        disabled={pin.length === 0 || loading}
                        className="flex items-center justify-center py-4 rounded-xl border-2 border-border bg-white text-charcoal disabled:opacity-25 active:scale-95 active:bg-cream transition-all duration-100 select-none"
                      >
                        <Delete size={20} strokeWidth={2} />
                      </button>
                    );
                  }
                  if (key === "submit") {
                    return (
                      <button
                        key="submit"
                        type="button"
                        onClick={() => submitPin(pin)}
                        disabled={pin.length < 4 || loading}
                        className="flex items-center justify-center py-4 rounded-xl bg-orange text-white disabled:opacity-30 active:scale-95 transition-all duration-100 shadow-lg shadow-orange/30 select-none"
                      >
                        {loading
                          ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                          : <ArrowRight size={22} strokeWidth={2.5} />
                        }
                      </button>
                    );
                  }
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => pressKey(key)}
                      disabled={loading}
                      className="py-4 rounded-xl border-2 border-border bg-white text-charcoal text-xl font-bold active:scale-95 active:bg-cream transition-all duration-100 select-none disabled:opacity-40"
                    >
                      {key}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* Username */}
              <div className="mb-4">
                <label className="block text-xs font-bold text-brown uppercase tracking-wider mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                  placeholder="e.g. ahmed"
                  autoCapitalize="none"
                  autoComplete="username"
                  className="w-full px-4 py-3 border-2 border-border rounded-xl focus:ring-2 focus:ring-orange/30 focus:border-orange outline-none transition-colors text-charcoal font-medium text-sm"
                />
              </div>

              {/* Password */}
              <div className="mb-5">
                <label className="block text-xs font-bold text-brown uppercase tracking-wider mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    className="w-full px-4 py-3 border-2 border-border rounded-xl focus:ring-2 focus:ring-orange/30 focus:border-orange outline-none transition-colors pr-12 text-charcoal font-medium text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-brown/50 hover:text-charcoal transition-colors"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={submitPassword}
                disabled={loading}
                className="w-full py-3.5 bg-orange hover:bg-orange-dark text-white font-bold rounded-xl transition-all duration-200 disabled:opacity-50 shadow-lg shadow-orange/25 hover:shadow-orange/40 active:scale-[0.98] mb-4 flex items-center justify-center gap-2"
              >
                {loading
                  ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Signing in…</>
                  : "Sign In"
                }
              </button>

              {error && (
                <div className="bg-danger-bg text-danger px-4 py-2.5 rounded-xl text-sm font-semibold mb-4 text-center">
                  {error}
                </div>
              )}
            </>
          )}

          {/* Mode toggle */}
          <div className="text-center pt-1">
            {mode === "pin" ? (
              <button
                type="button"
                onClick={() => switchMode("password")}
                className="text-sm text-brown/50 hover:text-orange transition-colors font-medium"
              >
                الدخول باسم المستخدم وكلمة المرور →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => switchMode("pin")}
                className="text-sm text-brown/50 hover:text-orange transition-colors font-medium"
              >
                ← العودة للدخول السريع بالـ PIN
              </button>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
