"use client";
// «طريقة المحطة» — a roaster's station screen, the previous one (V1) or the new one (roast station v2), switched from the
// roaster's settings page (production › manage_roasters, or the admin role). The server keeps every guard and answers
// a refusal in both languages; it is shown here, under the control. PATCH …/roasters/[id]/station-mode.
import { useState } from "react";
import { call, errText, useLang, type ApiError } from "./shared";

export function StationModeControl({ roasterId, mode, canChange, onChanged }: { roasterId: string; mode: "V1" | "V2"; canChange: boolean; onChanged: (m: "V1" | "V2") => void }) {
  const { ar, L } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pick = async (m: "V1" | "V2") => {
    if (m === mode || busy) return;
    setBusy(true); setErr(null); setDone(false);
    const r = await call<{ id: string; stationMode: "V1" | "V2" }>(`/api/settings/production/roasters/${roasterId}/station-mode`, "PATCH", { stationMode: m });
    setBusy(false);
    if (r.ok) { onChanged(r.data.stationMode); setDone(true); }
    else setErr(errText(r.data as ApiError, ar, "تعذّر تغيير طريقة المحطة. لم يتغير شيء.", "Could not change the station. Nothing was changed."));
  };
  const opt = (m: "V1" | "V2", label: string) => (
    <button type="button" role="radio" aria-checked={mode === m} className={`hr-btn${mode === m ? " is-primary" : ""}`} disabled={!canChange || busy} onClick={() => void pick(m)} data-testid={`roaster-mode-${m}`} style={{ minHeight: 44 }}>
      {mode === m ? "✓ " : ""}{label}
    </button>
  );
  return (
    <section className="ss-stack" data-testid="roaster-station-mode" style={{ gap: 8 }}>
      <h3 className="ss-lbl">{L("طريقة المحطة", "Station")}</h3>
      <p className="ss-muted" data-testid="roaster-mode-now">
        {L("الحالية: ", "Now: ")}<strong>{mode === "V2" ? L("الجديدة (v2)", "New (v2)") : L("القديمة", "Previous")}</strong>
        {" · "}{mode === "V2" ? L("الدرام ← التبريد ← السلّة، بالدلاء والسلال.", "Drum → cooler → basket, with buckets and baskets.") : L("طابور التحميص والدفعات كما كانت.", "The roasting queue and batches as before.")}
      </p>
      <div role="radiogroup" aria-label={L("طريقة المحطة", "Station")} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {opt("V1", L("القديمة", "Previous"))}
        {opt("V2", L("الجديدة (v2)", "New (v2)"))}
      </div>
      {!canChange ? <p className="ss-muted" data-testid="roaster-mode-readonly">{L("يغيّرها من يملك إدارة الحمّاصات.", "Changed by someone with roaster management.")}</p> : null}
      {err ? <div className="hr-notice tone-danger" role="alert" data-testid="roaster-mode-error">{err}</div> : null}
      {done ? <div className="hr-notice tone-success" role="status" data-testid="roaster-mode-saved">{L("تغيّرت طريقة المحطة. تظهر الشاشة الجديدة عند فتح المحطة.", "The station changed. The station screen follows when it is opened.")}</div> : null}
      <p className="ss-muted">{L("لا تتغير إلا والحمّاصة فارغة: لا بلاغ مفتوح، ولا تحميصات بلا وزن، ولا خانة قيد التحميص.", "It changes only when the roaster is clear: no open problem, no unweighed roasts, no slot being roasted.")}</p>
    </section>
  );
}
