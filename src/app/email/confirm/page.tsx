"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../public.css";

/** «وصلتني» — opened from the test e-mail (batch 25): one button records that the test address receives our e-mail. */
function Confirm() {
  const t = useSearchParams().get("t") ?? "";
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  async function confirm() {
    setState("busy");
    const r = await fetch("/api/email/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t }) }).catch(() => null);
    if (r?.ok) return setState("done");
    const j = (await r?.json().catch(() => null)) as { error?: string } | null;
    setErr(j?.error ?? "تعذّر الطلب. حاول مرة ثانية.");
    setState("error");
  }
  return (
    <main className="em-pub" dir="rtl" lang="ar">
      <div className="card" data-testid="confirm-card">
        <div className="bar" />
        {state === "done" ? (
          <>
            <h1 className="ok" data-testid="confirm-done">تمام، وصلتك رسالة التجربة</h1>
            <p>سجّلنا إن إيميل التجربة يستقبل رسائلنا. «فعلي» للإيميل يبقى مقفل لين تطلب من الدعم الفني فتحه على الخادم؛ بعدها تختاره من «إعدادات الإرسال».</p>
          </>
        ) : (
          <>
            <h1>وصلتك رسالة التجربة؟</h1>
            <p>اضغط «وصلتني» عشان نسجّل إن الإيميل يوصل.</p>
            {state === "error" ? <p className="err" role="alert" data-testid="confirm-error">{err}</p> : null}
            <button type="button" onClick={confirm} disabled={state === "busy" || !t} data-testid="confirm-button">{state === "busy" ? "جارٍ التسجيل…" : "وصلتني"}</button>
          </>
        )}
      </div>
    </main>
  );
}

export default function Page() {
  return <Suspense><Confirm /></Suspense>;
}
