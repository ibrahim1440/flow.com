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
