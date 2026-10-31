"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import "../public.css";

/**
 * «إيقاف الإيميلات» — the public page the link in every customer e-mail opens (batch 25). Nothing changes on opening
 * it (mail security scanners open links); the customer presses one button, then reads «تم إيقاف الإيميلات».
 */
function Unsubscribe() {
  const t = useSearchParams().get("t") ?? "";
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  async function stop() {
    setState("busy");
    const r = await fetch(`/api/email/unsubscribe?t=${encodeURIComponent(t)}`, { method: "POST" }).catch(() => null);
    if (r?.ok) return setState("done");
    const j = (await r?.json().catch(() => null)) as { error?: string } | null;
    setErr(j?.error ?? "تعذّر الطلب. حاول مرة ثانية.");
    setState("error");
  }
  return (
    <main className="em-pub" dir="rtl" lang="ar">
      <div className="card" data-testid="unsubscribe-card">
        <div className="bar" />
        {state === "done" ? (
          <>
            <h1 className="ok" data-testid="unsubscribe-done">تم إيقاف الإيميلات</h1>
            <p>ما راح توصلك إيميلات تلقائية منّا بعد اليوم. لو تبي ترجّعها، كلّم مندوبك.</p>
          </>
        ) : (
          <>
            <h1>إيقاف الإيميلات</h1>
            <p>تبي نوقف الإيميلات التلقائية اللي تجيك منّا (عروض الأسعار وتحديثات الطلبات)؟</p>
            {state === "error" ? <p className="err" role="alert" data-testid="unsubscribe-error">{err}</p> : null}
            <button type="button" onClick={stop} disabled={state === "busy" || !t} data-testid="unsubscribe-confirm">{state === "busy" ? "جارٍ الإيقاف…" : "أوقف الإيميلات"}</button>
            <p className="muted" style={{ marginTop: 14 }}>رسائل الواتساب ما تتأثر.</p>
          </>
        )}
      </div>
    </main>
  );
}

export default function Page() {
  return <Suspense><Unsubscribe /></Suspense>;
}
