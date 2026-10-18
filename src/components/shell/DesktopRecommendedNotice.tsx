"use client";

import { useEffect, useState } from "react";

/**
 * Phase 1 is desktop-first (owner decision, 18 Oct 2026): phone and tablet use is
 * DEFERRED — NOT TESTED — NOT CERTIFIED. Below the 1280 px desktop layout this says so, once,
 * in one dismissible line. Presentation only: nothing is blocked and no user agent is read.
 *
 * It renders nothing on the server and nothing at ≥ 1280 px, so the 1440 desktop screens
 * (and their Figma parity) are untouched. The dismissal is remembered per browser; storage
 * may be unavailable (private window, blocked site data), in which case it simply shows again.
 */
const KEY = "hq.desktopNotice.dismissed";
const NARROW = "(max-width: 1279px)";

export function DesktopRecommendedNotice({ lang }: { lang: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(KEY) === "1"; } catch { /* storage unavailable */ }
    if (dismissed) return;
    const mq = window.matchMedia(NARROW);
    const update = () => setShow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (!show) return null;

  const ar = lang !== "en";
  const dismiss = () => {
    try { window.localStorage.setItem(KEY, "1"); } catch { /* storage unavailable */ }
    setShow(false);
  };

  return (
    <div
      role="note"
      className="desk-notice"
      dir={ar ? "rtl" : "ltr"}
      lang={ar ? "ar" : "en"}
      data-testid="desktop-recommended"
    >
      <span className="desk-notice-text">
        {ar
          ? "يُوصى باستخدام متصفح على جهاز مكتبي — الجوال والأجهزة اللوحية غير معتمدة في المرحلة الأولى."
          : "Desktop browser recommended — mobile and tablet are not certified in Phase 1."}
      </span>
      <button
        type="button"
        className="desk-notice-close"
        onClick={dismiss}
        aria-label={ar ? "إخفاء التنبيه" : "Dismiss notice"}
        data-testid="desktop-recommended-dismiss"
      >
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}
