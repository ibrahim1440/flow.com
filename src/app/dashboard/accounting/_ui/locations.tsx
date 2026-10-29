"use client";

// «الموقع» (BATCH22 WP-B) — the location filter of the accountant workspace's lists and reports. The options are the
// active branches (GET /api/accounting/locations) plus «غير محدد» (documents / lines with no location, token "none").
// Presentation only: the APIs apply the filter (`branches=a,b,none`).
import { useEffect, useState } from "react";
import { MultiPick, type PickOption } from "@/components/chrome";
import { useLang } from "./shell";

export type LocationOption = { id: string; code: string; nameAr: string; nameEn: string; sites: { id: string; code: string; nameAr: string; nameEn: string | null }[] };
export const UNASSIGNED_LOCATION = "none";

/** The active locations (empty while loading or when the viewer may not read them). */
export function useLocations(): LocationOption[] {
  const [rows, setRows] = useState<LocationOption[]>([]);
  useEffect(() => {
    let off = false;
    fetch("/api/accounting/locations").then((r) => (r.ok ? r.json() : null)).then((j: { locations?: LocationOption[] } | null) => { if (!off && j?.locations) setRows(j.locations); }).catch(() => {});
    return () => { off = true; };
  }, []);
  return rows;
}

/** The location's name in the viewer's language («غير محدد» for none). */
export function useLocationName() {
  const { L } = useLang();
  const rows = useLocations();
  return (id: string | null | undefined) => {
    if (!id) return L("غير محدد", "Unassigned");
    const b = rows.find((r) => r.id === id);
    return b ? L(b.nameAr, b.nameEn) : id;
  };
}

/** The `branches=` query value of a selection ("" = all). */
export const branchesQuery = (v: string[]) => (v.length ? `branches=${encodeURIComponent(v.join(","))}` : "");

/** «الموقع» multi-select: the locations and «غير محدد». Empty = all. */
export function LocationFilter({ value, onChange, testId = "location-filter" }: { value: string[]; onChange: (v: string[]) => void; testId?: string }) {
  const { L } = useLang();
  const rows = useLocations();
  const options: PickOption[] = [...rows.map((r) => ({ value: r.id, label: L(r.nameAr, r.nameEn) })), { value: UNASSIGNED_LOCATION, label: L("غير محدد", "Unassigned") }];
  return <MultiPick label={L("الموقع", "Location")} options={options} value={value} onChange={onChange} allLabel={L("كل المواقع", "All locations")} testId={testId} />;
}
