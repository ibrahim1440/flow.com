"use client";
// Settings › Production & roasting › QC (owner decision D1): the minimum number of evaluators per
// batch. GET / PUT /api/settings/production/qc (admin role, step-up, SettingsAuditLog). Fewer than
// this at decision time is an exceptional approval (qc › finalize_override, D2).
import { useEffect, useState } from "react";
import { useL } from "@/components/ops/ui";
import { SingleSetting } from "../../_parts/single-setting";
import "../../_parts/sections.css";

type Qc = { minEvaluators: number | null; effectiveMinEvaluators: number; isDefault: boolean; range: { min: number; max: number; default: number }; can: { edit: boolean } };

export function QcMinSection() {
  const L = useL();
  const [s, setS] = useState<Qc | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch("/api/settings/production/qc", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setS).catch(() => setFailed(true));
  }, []);
  return (
    <section data-testid="qc-settings">
      <div className="ss-bh">
        <h2>{L("الجودة", "Quality control")}</h2>
        <span>{L("يطبّق على قرار الجودة لكل دفعة", "Applies to every batch's QC decision")}</span>
      </div>
      {failed ? <p className="ss-muted" role="alert">{L("تعذّر تحميل إعداد الجودة.", "Could not load the QC setting.")}</p> : !s ? null : (
        <SingleSetting
          url="/api/settings/production/qc" field="minEvaluators" testId="qc-min"
          stored={s.minEvaluators === null ? null : String(s.minEvaluators)} effective={String(s.effectiveMinEvaluators)} isDefault={s.isDefault} canEdit={s.can.edit}
          label={L("الحد الأدنى للمقيّمين", "Minimum evaluators")}
          help={L(`فارغ = الافتراضي ${s.range.default} · من ${s.range.min} إلى ${s.range.max} · أقل منه يتطلب «اعتمادًا استثنائيًا» بصلاحية مستقلة`, `Empty = the default ${s.range.default} · ${s.range.min}–${s.range.max} · fewer needs an «exceptional approval» (a separate permission)`)}
          unit={L("مقيّم", "evaluators")}
          onSaved={(j) => setS((x) => (x ? { ...x, ...(j as Partial<Qc>) } : x))}
          savedText={(j) => L(`حُفظ. الحد الأدنى الآن ${String(j.effectiveMinEvaluators)} مقيّم لكل دفعة.`, `Saved. The minimum is now ${String(j.effectiveMinEvaluators)} evaluators per batch.`)}
        />
      )}
    </section>
  );
}
