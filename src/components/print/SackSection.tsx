"use client";
/**
 * «الأكياس» in the print dialog of a green-coffee lot (20261114090000_green_lot_labels): one numbered label per sack
 * («كيس 3 من 15») or one label for the lot. The sack count and weight are the lot's own (GreenBean.sackCount /
 * sackWeightKg) — entered here or on the lot form, saved to the lot, so a reprint of sacks 3–5 later reads the same
 * numbers. The range picks which sacks to print (a torn label, a new sack line).
 */
import { useState } from "react";
import { Btn, Notice } from "@/components/hr/ui";
import { useL } from "@/components/ops/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useI18n } from "@/lib/i18n/context";

export type SackMode = { mode: "sacks" | "lot"; from: number; to: number };
export type Sacks = { count: number | null; kg: number | null };

export function SackSection({ greenBeanId, label, sacks, receivedKg, value, onChange, onSaved }: {
  greenBeanId: string; label: string; sacks: Sacks; receivedKg?: number | null;
  value: SackMode; onChange: (v: SackMode) => void; onSaved: (s: Sacks) => void;
}) {
  const L = useL();
  const { lang } = useI18n();
  const [count, setCount] = useState(sacks.count ? String(sacks.count) : "");
  const [kg, setKg] = useState(sacks.kg ? String(sacks.kg) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = Number(count), w = kg.trim() === "" ? null : Number(kg);
  const valid = Number.isInteger(n) && n >= 1 && n <= 999 && (w === null || (Number.isFinite(w) && w > 0 && w <= 1000));
  const changed = n !== (sacks.count ?? 0) || (w ?? null) !== (sacks.kg ?? null);
  const total = valid && w ? Math.round(n * w * 1000) / 1000 : null;
  const mismatch = total !== null && receivedKg && Math.abs(total - receivedKg) > 0.01;

  async function save() {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/green-beans/${encodeURIComponent(greenBeanId)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sackCount: n, sackWeightKg: w }),
    }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      const j = r ? await r.json().catch(() => ({})) : {};
      setErr(r?.status === 403 ? L("حفظ الأكياس يحتاج صلاحية الاستلام أو التسوية في المخزون.", "Saving the sacks needs inventory › receive or adjust.") : localizeApiError(j, lang) ?? L("تعذّر حفظ الأكياس.", "Could not save the sacks."));
      return;
    }
    onSaved({ count: n, kg: w });
    onChange({ mode: "sacks", from: 1, to: n });
  }

  const sackOn = value.mode === "sacks";
  const max = sacks.count ?? 0;
  const clamp = (v: number) => Math.min(Math.max(1, Math.round(v) || 1), Math.max(1, max));
  return (
    <div className="pd-sacks" data-testid={`pd-sacks-${greenBeanId}`}>
      <div className="pd-seg" role="group" aria-label={`${L("طريقة الطباعة", "How to print")} · ${label}`} data-testid="pd-sack-mode">
        <button type="button" aria-pressed={sackOn} onClick={() => onChange({ ...value, mode: "sacks", from: 1, to: max || 1 })} data-key="sacks">{L("ملصق لكل كيس", "A label per sack")}</button>
        <button type="button" aria-pressed={!sackOn} onClick={() => onChange({ ...value, mode: "lot" })} data-key="lot">{L("ملصق واحد للوت", "One label for the lot")}</button>
      </div>
      {sackOn ? (
        <>
          <div className="pd-sack-grid">
            <label className="hr-field"><span className="hr-label">{L("عدد الأكياس", "Sacks")}</span>
              <input className="hr-input" type="number" inputMode="numeric" min={1} max={999} value={count} onChange={(e) => setCount(e.target.value)} data-testid="pd-sack-count" /></label>
            <label className="hr-field"><span className="hr-label">{L("وزن الكيس · كغ", "Sack weight · kg")}</span>
              <input className="hr-input" type="number" inputMode="decimal" min={0} step="0.01" value={kg} onChange={(e) => setKg(e.target.value)} placeholder={L("اختياري", "Optional")} data-testid="pd-sack-weight" /></label>
          </div>
          {total !== null ? <span className={`hr-caption${mismatch ? " pd-warn-text" : ""}`} data-testid="pd-sack-total">
            <bdi dir="ltr">{n} × {w}</bdi> = <bdi dir="ltr">{total}</bdi> {L("كغ", "kg")}{mismatch ? ` · ${L(`المستلم ${receivedKg} كغ`, `received ${receivedKg} kg`)}` : ""}
          </span> : null}
          {changed ? (
            <Btn size="sm" variant={sacks.count ? "secondary" : "primary"} disabled={!valid || busy} busy={busy} onClick={save} data-testid="pd-sack-save">
              {sacks.count ? L("حفظ التعديل على اللوت", "Save the change to the lot") : L("حفظ الأكياس في اللوت", "Save the sacks on the lot")}
            </Btn>
          ) : null}
          {!sacks.count ? <span className="hr-caption">{L("احفظ عدد الأكياس أولًا: يُقرأ «كيس n من N» من اللوت، فتطابق أي إعادة طباعة.", "Save the sack count first: «Sack n of N» is read from the lot, so any reprint matches.")}</span> : (
            <div className="pd-row" data-testid="pd-sack-range">
              <span>{L("من الكيس", "From sack")}</span>
              <input className="hr-input pd-sack-n" type="number" inputMode="numeric" min={1} max={max} value={value.from} aria-label={L("من الكيس", "From sack")}
                onChange={(e) => { const f = clamp(Number(e.target.value)); onChange({ ...value, from: f, to: Math.max(f, value.to) }); }} data-testid="pd-sack-from" />
              <span>{L("إلى", "to")}</span>
              <input className="hr-input pd-sack-n" type="number" inputMode="numeric" min={1} max={max} value={value.to} aria-label={L("إلى الكيس", "To sack")}
                onChange={(e) => { const t = clamp(Number(e.target.value)); onChange({ ...value, to: t, from: Math.min(t, value.from) }); }} data-testid="pd-sack-to" />
              {value.from !== 1 || value.to !== max ? <button type="button" className="ops-link pd-linkbtn" onClick={() => onChange({ ...value, from: 1, to: max })}>{L("كل الأكياس", "All sacks")}</button> : null}
            </div>
          )}
        </>
      ) : null}
      {err ? <Notice tone="danger">{err}</Notice> : null}
    </div>
  );
}
