"use client";
// /station/roasting — Workstations W1 (Phase 9, Figma page 630:2) and, for a roaster switched to V2, «محطة التحميص v2»
// (D12, Figma 1868:2): a paired device serves its roaster's mode; a personal session serves V2 when the operator is
// assigned to V2 roasters (one or two: the switcher «المحمصة 1 | المحمصة 2»), and the V1 screen otherwise.
import { useEffect, useState } from "react";
import { useStation } from "../_ui/context";
import { RoastingStation } from "./_ui/RoastingStation";
import { StationV2 } from "./_v2/StationV2";
import { v2t } from "./_v2/i18n";

type R = { id: string; name: string; assigned: boolean; stationMode: string };

const ROASTER_KEY = "hq.station.roaster";

export default function RoastingStationPage() {
  const { station, mode, user } = useStation();
  const lang = user.preferredLanguage === "en" ? "en" : "ar";
  const [lists, setLists] = useState<{ v2: R[]; v1: R[] } | null>(null);
  const [v1Pick, setV1Pick] = useState<string | null>(null);   // a personal operator on both: the V1 roaster chosen
  useEffect(() => {
    let off = false;
    fetch("/api/station/roasters", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { roasters: [] })).catch(() => ({ roasters: [] })).then((j: { roasters: R[] }) => {
      if (off) return;
      const all = j.roasters ?? [];
      const mine = mode === "device" ? all.filter((r) => r.id === station?.roaster?.id) : all.filter((r) => r.assigned);
      setLists({ v2: mine.filter((r) => r.stationMode === "V2").slice(0, 2), v1: mode === "device" ? [] : mine.filter((r) => r.stationMode !== "V2") });
    });
    return () => { off = true; };
  }, [mode, station]);
  if (lists === null) return <div className="ws-plain" role="status">…</div>;
  const { v2, v1 } = lists;
  if (!v2.length) return <RoastingStation />;
  const names = Object.fromEntries([...v2, ...v1].map((r) => [r.id, r.name]));
  const pickV1 = (id: string) => { try { sessionStorage.setItem(ROASTER_KEY, id); } catch { /* private mode */ } setV1Pick(id); };
  if (v1Pick) {
    // The V1 screen, with the way back to the V2 roasters (the same switcher, V1 roasters marked).
    return (
      <>
        <nav aria-label={v2t(lang, "roasterTabs")} data-testid="rv2-v1-switch" style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 12px", borderBottom: "1px solid var(--border-subtle, #efeadf)", background: "var(--surface, #fff)" }}>
          {[...v2, ...v1].map((r) => {
            const on = r.id === v1Pick;
            return (
              <button key={r.id} aria-pressed={on} onClick={() => { if (r.stationMode === "V2") setV1Pick(null); else pickV1(r.id); }} data-testid={`rv2-roaster-${r.id}`}
                style={{ minHeight: 44, padding: "0 14px", borderRadius: 999, border: `1.5px solid ${on ? "var(--text-primary, #28241a)" : "var(--border-strong, #e3dccb)"}`, background: on ? "var(--surface-selected, #f0f0e9)" : "var(--surface, #fff)", fontWeight: on ? 700 : 500, fontSize: 15 }}>
                {r.name}{r.stationMode === "V2" ? "" : ` · ${v2t(lang, "previousScreen")}`}
              </button>
            );
          })}
        </nav>
        <RoastingStation key={v1Pick} />
      </>
    );
  }
  return <StationV2 roasterIds={v2.map((r) => r.id)} roasterNames={names} otherRoasters={v1.map((r) => r.id)} onPickOther={pickV1} />;
}
