"use client";
// Stock locations on the client (unified inventory phase 3, 20261115090000_stock_locations): the locations list hook, the
// per-location balances, the «كل المواقع» filter, the per-location breakdown of an item, and the «الرصيد في هذا الموقع
// لا يكفي» notice with its prefilled transfer. A location says WHERE stock is; the totals stay company-wide.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/Select";
import { Field, useL } from "@/components/ops/ui";
import { useI18n } from "@/lib/i18n/context";
import { locationName, pickerLocations, type LocationRow } from "@/lib/inventory/locations";

export type Loc = LocationRow & {
  address?: string | null; notes?: string | null; deactivatedAt?: string | null; deactivationReason?: string | null;
  hasHistory?: boolean; valueEstimate?: number; holdings?: { green: number; materials: number; finished: number; any: boolean };
  /** «الموقع» (20261125090000_location_dimension): the accounting branch the site belongs to. */
  finBranchId?: string | null;
};
export type LocationsState = { locations: Loc[]; defaultId: string | null; productionId: string | null; lastReceivingId: string | null };
export type Balances = { green: Record<string, { locationId: string; qty: number }[]>; material: Record<string, { locationId: string; qty: number }[]>; finished: Record<string, string> };

export function useLocations(all = false) {
  const [state, setState] = useState<LocationsState | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch(`/api/inventory/locations${all ? "?all=1" : ""}`).catch(() => null);
    if (r?.ok) { setState(await r.json()); setFailed(false); } else setFailed(true);
  }, [all]);
  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/locations${all ? "?all=1" : ""}`).then(async (r) => { if (off) return; if (r.ok) setState(await r.json()); else setFailed(true); }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [all]);
  return { state, failed, reload: load };
}

export function useBalances(refreshKey: number) {
  const [b, setB] = useState<Balances | null>(null);
  useEffect(() => {
    let off = false;
    fetch("/api/inventory/locations/balances").then(async (r) => { if (!off && r.ok) setB(await r.json()); }).catch(() => undefined);
    return () => { off = true; };
  }, [refreshKey]);
  return b;
}

/** A location picker of the ACTIVE locations (an inactive one disappears from pickers, never from history). */
export function LocationSelect({ locations, value, onChange, allOption, label, testId, disabled, exclude }: {
  locations: Loc[]; value: string; onChange: (id: string) => void; allOption?: string; label: string; testId?: string; disabled?: boolean; exclude?: string | null;
}) {
  const { lang } = useI18n();
  const L = useL();
  const rows = pickerLocations(locations).filter((l) => l.id !== exclude);
  return (
    <Select className="hr-select" aria-label={label} data-testid={testId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {allOption !== undefined ? <option value="">{allOption}</option> : null}
      {rows.map((l) => <option key={l.id} value={l.id}>{locationName(l, lang)}{l.isDefault ? ` · ${L("الافتراضي", "default")}` : ""}</option>)}
    </Select>
  );
}

/**
 * «موقع الرصيد الافتتاحي»: where the starting quantity of a new green lot / material is received — shown only once a
 * quantity above zero is entered and more than one site exists; it starts on the default receiving site. `value` ""
 * means that default (the server books it there too).
 */
export function OpeningSiteField({ qty, value, onChange }: { qty: number; value: string; onChange: (id: string) => void }) {
  const L = useL();
  const { state } = useLocations(false);
  if (!(qty > 0) || !state || pickerLocations(state.locations).length < 2) return null;
  return (
    <Field label={L("موقع الرصيد الافتتاحي", "Opening stock location")} help={L("يُسجَّل الرصيد الافتتاحي كاستلام في هذا الموقع.", "The opening quantity is received at this location.")}>
      <LocationSelect locations={state.locations} value={value || state.defaultId || ""} onChange={onChange} label={L("موقع الرصيد الافتتاحي", "Opening stock location")} testId="opening-site" />
    </Field>
  );
}

/** «مصنع التحميص 40 · المقهى 5» — where an item's balance is (only locations holding some). */
export function LocationBreakdown({ rows, locations, digits = 2, testId }: { rows: { locationId: string; qty: number }[] | undefined; locations: Loc[]; digits?: number; testId?: string }) {
  const { lang } = useI18n();
  const L = useL();
  const list = (rows ?? []).filter((r) => r.qty > 0).sort((a, b) => {
    const la = locations.find((l) => l.id === a.locationId), lb = locations.find((l) => l.id === b.locationId);
    return (la?.sortOrder ?? 99) - (lb?.sortOrder ?? 99);
  });
  if (!list.length) return <span className="loc-where hr-caption" data-testid={testId}>{L("لا رصيد في أي موقع", "No stock at any location")}</span>;
  return (
    <span className="loc-where" data-testid={testId}>
      {list.map((r, i) => {
        const l = locations.find((x) => x.id === r.locationId);
        const q = Number(r.qty.toFixed(digits));
        return (
          <span key={r.locationId} className="loc-chip">
            {i ? <span aria-hidden="true" className="loc-sep">·</span> : null}
            <span>{l ? locationName(l, lang) : r.locationId}</span>{" "}
            <span className="hr-num">{q}</span>
          </span>
        );
      })}
    </span>
  );
}

export type ShortLocation = { locationId?: string; locationName?: string | null; locationNameEn?: string | null; available?: number; requested?: number; shortBy?: number; transferHref?: string | null; from?: { nameAr: string; nameEn: string | null; qty: number } | null };

/** The refusal of a draw at a location that lacks the stock, with the transfer that fixes it. */
export function ShortStockHint({ location }: { location: ShortLocation | null | undefined }) {
  const L = useL();
  const { lang } = useI18n();
  if (!location?.transferHref) return null;
  const from = location.from ? (lang === "en" ? location.from.nameEn || location.from.nameAr : location.from.nameAr) : null;
  return (
    <span className="loc-hint" data-testid="short-stock-hint">
      {from ? L(`الرصيد موجود في «${from}». `, `The stock is at «${from}». `) : null}
      <Link className="ops-link" href={location.transferHref} data-testid="short-stock-transfer">{L("حوّل المخزون إلى موقع الإنتاج", "Transfer the stock to the production site")}</Link>
    </span>
  );
}

// ─── Reorder points per location (20261117090000_locations_enhancements, owner decision 3) ─────────

type SitePoint = { id: string; code: string; nameAr: string; nameEn: string | null; isProduction: boolean; qty: number; reorderPoint: number | null; low: boolean };

/**
 * «حد إعادة الطلب في كل موقع»: one row per active site — the item's balance there and its reorder point there (empty =
 * none). Saved on its own (PUT /api/inventory/reorder-points); shown in the item's settings — and, for a finished SKU, in
 * the SKU's settings (units: its AVAILABLE units at each site). The company-wide reorder point stays where it is.
 */
export function SiteReorderEditor({ itemKind, entityId, unit, canEdit }: { itemKind: "GREEN_BEAN" | "MATERIAL" | "PRODUCT_SKU"; entityId: string; unit: string; canEdit: boolean }) {
  const L = useL();
  const { lang } = useI18n();
  const [sites, setSites] = useState<SitePoint[] | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const apply = useCallback((j: { sites: SitePoint[] }) => {
    setSites(j.sites);
    setVals(Object.fromEntries(j.sites.map((s) => [s.id, s.reorderPoint ? String(s.reorderPoint) : ""])));
  }, []);
  const url = `/api/inventory/reorder-points?itemKind=${itemKind}&entityId=${encodeURIComponent(entityId)}`;
  const load = useCallback(async () => {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) apply(await r.json());
  }, [url, apply]);
  useEffect(() => {
    let off = false;
    fetch(url).then(async (r) => { if (!off && r.ok) apply(await r.json()); }).catch(() => undefined);
    return () => { off = true; };
  }, [url, apply]);
  if (!sites || sites.length < 2) return null;
  const dirty = sites.some((s) => (vals[s.id] ?? "") !== (s.reorderPoint ? String(s.reorderPoint) : ""));
  async function save() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/inventory/reorder-points", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemKind, entityId, points: sites!.map((s) => ({ locationId: s.id, reorderPoint: (vals[s.id] ?? "").trim() || null })) }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { const j = await r?.json().catch(() => ({})); setMsg({ tone: "danger", text: (lang === "en" ? j?.errorEn ?? j?.error : j?.error ?? j?.errorEn) ?? L("تعذّر الحفظ.", "Could not save.") }); return; }
    setMsg({ tone: "success", text: L("حُفظت حدود المواقع.", "Site reorder points saved.") });
    void load();
  }
  return (
    <div className="loc-reorder" data-testid="site-reorder">
      <div className="loc-reorder-h">
        <strong>{L("حد إعادة الطلب في كل موقع", "Reorder point per location")}</strong>
        <span className="hr-caption">{L("يُنبَّه «تحت حد إعادة الطلب» لكل موقع على حدة. فارغ = بلا حد.", "«Below reorder point» is flagged for each location. Empty = no point.")}</span>
      </div>
      <div className="hr-tablewrap">
        <table className="hr-table" aria-label={L("حد إعادة الطلب في كل موقع", "Reorder point per location")}>
          <thead><tr><th>{L("الموقع", "Location")}</th><th className="num">{itemKind === "PRODUCT_SKU" ? L("المتاح (غير المحجوز)", "Free (not reserved)") : L("الرصيد", "On hand")}</th><th className="num">{L("حد إعادة الطلب", "Reorder point")}</th><th aria-label={L("التنبيه", "Flag")} /></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id} data-testid={`site-reorder-${s.code}`}>
                <td>{locationName(s, lang)}</td>
                <td className={`num${s.low ? " is-low" : ""}`}><span className="hr-num">{Number(s.qty.toFixed(2))}</span> <span className="hr-caption">{unit}</span></td>
                <td className="num">
                  <input className="hr-input loc-reorder-in" inputMode={itemKind === "PRODUCT_SKU" ? "numeric" : "decimal"} type="number" min={0} step={itemKind === "PRODUCT_SKU" ? 1 : "any"} disabled={!canEdit} aria-label={`${L("حد إعادة الطلب", "Reorder point")} · ${locationName(s, lang)}`}
                    data-testid={`site-reorder-input-${s.code}`} value={vals[s.id] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [s.id]: e.target.value }))} />
                </td>
                <td style={{ textAlign: "end" }}>{s.low ? <span className="stk-flag">{L("تحت الحد", "Below")}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <div className="loc-reorder-f">
          <button type="button" className="hr-btn is-sm" disabled={!dirty || busy} onClick={save} data-testid="site-reorder-save">{busy ? L("جارٍ الحفظ…", "Saving…") : L("حفظ حدود المواقع", "Save site points")}</button>
          {msg ? <span className={`hr-caption tone-${msg.tone}`} role="status">{msg.text}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

type SiteLow = { locationId: string; locationNameAr: string; locationNameEn: string | null; itemKind: string; entityId: string; code: string; name: string; nameAr: string | null; unit: string; qty: number; reorderPoint: number };

/** «تحت حد إعادة الطلب» per location: the items at or below a site's own reorder point (only when any are). */
export function SiteLowStock({ locationId, unitLabel }: { locationId?: string | null; unitLabel: (u: string, qty: number) => string }) {
  const L = useL();
  const { lang } = useI18n();
  const [rows, setRows] = useState<SiteLow[] | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/inventory/reorder-points/low${locationId ? `?location=${encodeURIComponent(locationId)}` : ""}`).then(async (r) => { if (!off && r.ok) setRows(((await r.json()) as { low: SiteLow[] }).low); }).catch(() => undefined);
    return () => { off = true; };
  }, [locationId]);
  if (!rows?.length) return null;
  return (
    <section className="loc-lows" aria-label={L("تحت حد إعادة الطلب في المواقع", "Below reorder point by location")} data-testid="site-low-stock">
      <h3 className="loc-lows-h">{L("تحت حد إعادة الطلب · حسب الموقع", "Below reorder point · by location")} <span className="hr-num">{rows.length}</span></h3>
      <ul className="loc-lows-l">
        {rows.map((r) => (
          <li key={`${r.locationId}:${r.itemKind}:${r.entityId}`} data-testid={`site-low-${r.code}`}>
            <span className="loc-chip">{lang === "en" ? r.locationNameEn || r.locationNameAr : r.locationNameAr}</span>
            <span className="strong">{lang === "en" ? r.name : r.nameAr || r.name}</span> <span className="hr-id">{r.code}</span>
            <span className="hr-caption"> · <span className="hr-num">{Number(r.qty.toFixed(2))}</span> {unitLabel(r.unit, r.qty)} {L("من حد", "of point")} <span className="hr-num">{r.reorderPoint}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type InTransit = { id: string; ref: string; sentAt: string | null; from: { nameAr: string; nameEn: string | null }; to: { nameAr: string; nameEn: string | null }; lines: { code: string; name: string; nameEn: string; qty: number; unit: string }[] };

/**
 * «في الطريق» (20261117090000_locations_enhancements): what two-step transfers have sent and not yet received — still
 * the company's stock (in the totals and the valuation), at no site. Each transfer opens to «استلام».
 */
export function InTransitPanel({ refreshKey, unitLabel }: { refreshKey: number; unitLabel: (u: string, qty: number) => string }) {
  const L = useL();
  const { lang } = useI18n();
  const [rows, setRows] = useState<InTransit[] | null>(null);
  useEffect(() => {
    let off = false;
    fetch("/api/inventory/transfers/lots").then(async (r) => { if (!off && r.ok) setRows(((await r.json()) as { inTransit: InTransit[] }).inTransit); }).catch(() => undefined);
    return () => { off = true; };
  }, [refreshKey]);
  if (!rows?.length) return null;
  const nm = (l: { nameAr: string; nameEn: string | null }) => (lang === "en" ? l.nameEn || l.nameAr : l.nameAr);
  return (
    <section className="loc-transit" aria-label={L("في الطريق", "In transit")} data-testid="in-transit">
      <h3 className="loc-lows-h">{L("في الطريق", "In transit")} <span className="hr-num">{rows.length}</span></h3>
      <p className="hr-caption" style={{ margin: 0 }}>{L("أُرسلت ولم تُستلم بعد — ضمن إجمالي المخزون وقيمته.", "Sent and not yet received — counted in the stock totals and value.")}</p>
      <ul className="loc-transit-l">
        {rows.map((t) => (
          <li key={t.id} data-testid={`in-transit-${t.ref}`}>
            <Link className="ops-link hr-id" href={`/dashboard/inventory/transfers/${t.id}`}>{t.ref}</Link>
            <span>{nm(t.from)} {lang === "en" ? "→" : "←"} {nm(t.to)}</span>
            <span className="hr-caption">{t.lines.map((l) => `${lang === "en" ? l.nameEn : l.name} ${Number(l.qty.toFixed(3))} ${unitLabel(l.unit, l.qty)}`).join(L("، ", ", "))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
