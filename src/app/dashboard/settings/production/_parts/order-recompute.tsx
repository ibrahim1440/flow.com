"use client";
// Settings › Production & roasting «إعادة حساب حالات الطلبات» (small-fixes batch): the one-time
// recompute of orders created before the automatic preparation existed. A dry run first — how many
// open orders are delivered in full and would close, how many the automatic preparation would run
// on — then, on confirmation, the same recompute applied (admin role, step-up; the dashboard's
// fetch wrapper asks for the step-up and retries once). GET / POST
// /api/settings/production/order-recompute; every run is audited in SettingsAuditLog.
// Shown to the admin role only (the dry run answers 403 to anyone else).
import { useEffect, useState } from "react";
import { Btn, useL } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import "../../_parts/sections.css";

type Brief = { id: string; orderNumber: number; status: string };
type Plan = { open: number; wouldClose: Brief[]; wouldStayOpen: Brief[]; wouldPrepare: Brief[] };
type Result = { closed: Brief[]; leftOpen: Brief[]; prepared: (Brief & { from: string | null; to: string | null })[]; preparedChecked: number };


export function OrderRecomputeSection() {
  const L = useL();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  // Whether to offer it at all: the dry run is the admin role's only.
  useEffect(() => {
    let off = false;
    fetch("/api/settings/production/order-recompute", { method: "GET", cache: "no-store" })
      .then((r) => { if (!off) setAllowed(r.ok); })
      .catch(() => { if (!off) setAllowed(false); });
    return () => { off = true; };
  }, []);

  async function dryRun() {
    setBusy(true); setErr(null); setResult(null); setPlan(null); setOpen(true);
    try {
      const r = await fetch("/api/settings/production/order-recompute", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(localizeApiError(j) ?? L("تعذّر حساب المعاينة.", "Could not compute the preview.")); return; }
      setPlan(j as Plan);
    } finally { setBusy(false); }
  }

  async function apply() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/settings/production/order-recompute", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(localizeApiError(j) ?? L("تعذّر التطبيق. لم يتغير شيء.", "Could not apply. Nothing was changed.")); return; }
      setResult(j as Result);
    } finally { setBusy(false); }
  }

  if (!allowed) return null;
  const nums = (xs: Brief[]) => xs.map((o) => `#${o.orderNumber}`).join(L("، ", ", "));
  const nothing = plan && plan.wouldClose.length === 0 && plan.wouldPrepare.length === 0;

  return (
    <section data-testid="order-recompute">
      <div className="ss-bh">
        <h2>{L("إعادة حساب حالات الطلبات", "Recompute order statuses")}</h2>
        <span>{L("مرة واحدة للطلبات القديمة · للمدير فقط", "One time, for older orders · admins only")}</span>
      </div>
      <div className="tl-card">
        <div>
          <strong>{L("الطلبات التي أُنشئت قبل التجهيز التلقائي", "Orders created before the automatic preparation")}</strong>
          <p>{L(
            "يُغلق كل طلب سُلِّم بالكامل وما زال «قيد التجهيز» أو «جاهز للشحن»، ثم يُعيد حساب تجهيز الطلبات المفتوحة. تظهر معاينة أولًا ولا يتغير شيء قبل التأكيد. التكرار آمن: التشغيل الثاني لا يغيّر شيئًا.",
            "Closes every order delivered in full that is still «Preparing» or «Ready for shipping», then recomputes the preparation of the open orders. A preview comes first and nothing changes before you confirm. Safe to repeat: a second run changes nothing.",
          )}</p>
        </div>
        <Btn size="sm" onClick={dryRun} disabled={busy} data-testid="order-recompute-open">{L("معاينة", "Preview")}</Btn>
      </div>

      <Dialog
        open={open}
        title={L("إعادة حساب حالات الطلبات", "Recompute order statuses")}
        onClose={() => { if (!busy) { setOpen(false); setPlan(null); setResult(null); setErr(null); } }}
        testId="order-recompute-dialog"
        actions={result ? (
          <Btn variant="primary" onClick={() => { setOpen(false); setPlan(null); setResult(null); }} data-testid="order-recompute-done">{L("تم", "Done")}</Btn>
        ) : (
          <>
            <Btn variant="primary" busy={busy} disabled={busy || !plan || !!nothing} onClick={apply} data-testid="order-recompute-apply">{L("تطبيق", "Apply")}</Btn>
            <Btn disabled={busy} onClick={() => { setOpen(false); setPlan(null); setErr(null); }}>{L("إلغاء", "Cancel")}</Btn>
          </>
        )}
      >
        {err ? <div className="hr-notice tone-danger" role="alert">{err}</div> : null}
        {!plan && !err ? <p className="ss-muted">{L("جارٍ حساب المعاينة…", "Computing the preview…")}</p> : null}
        {plan && !result ? (
          <div data-testid="order-recompute-plan">
            <p className="hr-caption" style={{ marginTop: 0 }}>{L("معاينة — لم يتغير شيء بعد.", "Preview — nothing has changed yet.")}</p>
            <dl className="hr-kv">
              <div><dt>{L("طلبات «قيد التجهيز» أو «جاهز للشحن»", "Orders «Preparing» or «Ready for shipping»")}</dt><dd className="hr-num">{plan.open}</dd></div>
              <div><dt>{L("ستُغلق (سُلِّمت بالكامل)", "Would close (delivered in full)")}</dt><dd><span className="hr-num" data-testid="order-recompute-would-close">{plan.wouldClose.length}</span>{plan.wouldClose.length ? <> · <bdi dir="ltr">{nums(plan.wouldClose)}</bdi></> : null}</dd></div>
              {plan.wouldStayOpen.length ? <div><dt>{L("سُلِّمت بالكامل وتبقى مفتوحة (حجز قائم — للمشرف)", "Delivered in full, stays open (a live reservation — for a supervisor)")}</dt><dd><span className="hr-num" data-testid="order-recompute-would-stay-open">{plan.wouldStayOpen.length}</span> · <bdi dir="ltr">{nums(plan.wouldStayOpen)}</bdi></dd></div> : null}
              <div><dt>{L("سيُعاد حساب تجهيزها", "Would be prepared again")}</dt><dd className="hr-num" data-testid="order-recompute-would-prepare">{plan.wouldPrepare.length}</dd></div>
            </dl>
            {nothing ? <p className="ss-muted">{L("لا يوجد ما يُعاد حسابه.", "There is nothing to recompute.")}</p> : null}
          </div>
        ) : null}
        {result ? (
          <div data-testid="order-recompute-result">
            <p className="hr-notice tone-success" role="status" style={{ marginTop: 0 }}>{L("طُبِّق وسُجِّل في سجل الإعدادات.", "Applied and recorded in the settings log.")}</p>
            <dl className="hr-kv">
              <div><dt>{L("أُغلقت", "Closed")}</dt><dd><span className="hr-num" data-testid="order-recompute-closed">{result.closed.length}</span>{result.closed.length ? <> · <bdi dir="ltr">{nums(result.closed)}</bdi></> : null}</dd></div>
              {result.leftOpen.length ? <div><dt>{L("بقيت مفتوحة (حجز قائم أو سطر غير مطابق — للمشرف)", "Left open (a live reservation or an inexact line — for a supervisor)")}</dt><dd><bdi dir="ltr">{nums(result.leftOpen)}</bdi></dd></div> : null}
              <div><dt>{L("تغيّر تجهيزها", "Preparation changed")}</dt><dd><span className="hr-num" data-testid="order-recompute-prepared">{result.prepared.length}</span> {L(`من ${result.preparedChecked}`, `of ${result.preparedChecked}`)}</dd></div>
            </dl>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
