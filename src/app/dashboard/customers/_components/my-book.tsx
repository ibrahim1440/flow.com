"use client";

// «عملائي» as the rep's book (owner-approved Figma «عملائي — لوحة دفتري», 3 Nov 2026): six counts and the tier strip
// above the list; every count and every tier filters the list under it (`?f=` in the address, so «يومي»'s
// «انتبه لعملائك» opens the same view and «رجوع» keeps it). The figures are «يومي»'s own (GET /api/sales/my-day →
// `book`), so a number on «يومي» and the customers it opens here are the same customers.
import { useEffect, useState } from "react";

export type BookStatus = "STOPPED" | "NEGOTIATING" | "ACTIVE" | "QUIET";
export type BookTier = "VIP" | "REGULAR" | "SMALL" | "QUIET";
export type BookRow = {
  id: string; tier: BookTier; kgPerMonth: number; lastOrderAt: string | null; status: BookStatus;
  growthPct: number | null; growing: boolean; declining: boolean; contractDaysLeft: number | null;
};
export type MyBook = {
  book: BookRow[];
  tiers: { totalKg: number; groups: { tier: BookTier; count: number; share: number }[] };
};

export const BOOK_FILTERS = ["active", "negotiating", "stopped", "growing", "declining", "contracts", "tier-VIP", "tier-REGULAR", "tier-SMALL", "tier-QUIET"] as const;
export type BookFilter = (typeof BOOK_FILTERS)[number];
export const isBookFilter = (v: string | null): v is BookFilter => !!v && (BOOK_FILTERS as readonly string[]).includes(v);

/** The rows a filter keeps — the single definition the counts and the list share. */
export function inFilter(r: BookRow, f: BookFilter): boolean {
  switch (f) {
    case "active": return r.status === "ACTIVE";
    case "negotiating": return r.status === "NEGOTIATING";
    case "stopped": return r.status === "STOPPED";
    case "growing": return r.growing;
    case "declining": return r.declining;
    case "contracts": return r.contractDaysLeft !== null;
    default: return r.tier === f.slice(5);
  }
}

const TIER_LABEL: Record<BookTier, [string, string]> = { VIP: ["VIP", "VIP"], REGULAR: ["عادي", "Regular"], SMALL: ["صغير", "Small"], QUIET: ["بدون طلبات حديثة", "No recent orders"] };
const FILTER_LABEL: Record<BookFilter, [string, string]> = {
  active: ["نشطين", "Active"], negotiating: ["يتفاوضون", "Negotiating"], stopped: ["متوقفين", "Stopped"],
  growing: ["ينمون", "Growing"], declining: ["يتراجعون", "Declining"], contracts: ["عقود قريبة", "Contracts ending"],
  "tier-VIP": ["VIP", "VIP"], "tier-REGULAR": ["عادي", "Regular"], "tier-SMALL": ["صغير", "Small"], "tier-QUIET": ["بدون طلبات حديثة", "No recent orders"],
};
export const filterLabel = (f: BookFilter, ar: boolean) => FILTER_LABEL[f][ar ? 0 : 1];

/** One status per customer for the list (the same priority as the counts), with the growth as a second word. */
export function statusOf(r: BookRow, ar: boolean): { text: string; tone: string } {
  const base = r.status === "STOPPED" ? { text: ar ? "متوقف" : "Stopped", tone: "wa" }
    : r.status === "NEGOTIATING" ? { text: ar ? "يتفاوض" : "Negotiating", tone: "in" }
    : r.status === "ACTIVE" ? { text: ar ? "نشط" : "Active", tone: "ok" }
    : { text: ar ? "بدون طلبات حديثة" : "No recent orders", tone: "" };
  if (r.declining && r.growthPct !== null) return { text: `${base.text} · ${ar ? "يتراجع" : "down"} ${Math.abs(Math.round(r.growthPct))}%`, tone: "er" };
  if (r.growing && r.growthPct !== null) return { text: `${base.text} · ${ar ? "ينمو" : "up"} ${Math.round(r.growthPct)}%`, tone: "ok" };
  return base;
}

export function useMyBook(enabled: boolean): MyBook | null {
  const [data, setData] = useState<MyBook | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    fetch("/api/sales/my-day", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((j: MyBook | null) => { if (!off && j && Array.isArray(j.book)) setData({ book: j.book, tiers: j.tiers }); })
      .catch(() => undefined);
    return () => { off = true; };
  }, [enabled]);
  return data;
}

const TILES: { f: BookFilter; tone: string; ar: string; en: string }[] = [
  { f: "active", tone: "ok", ar: "طلبوا خلال 3 شهور", en: "Ordered within 3 months" },
  { f: "negotiating", tone: "in", ar: "عندهم عرض أو صفقة", en: "Have a quote or deal" },
  { f: "stopped", tone: "wa", ar: "فات موعد طلبهم بكثير", en: "Well past their reorder" },
  { f: "growing", tone: "ok", ar: "كمياتهم زادت", en: "Ordering more" },
  { f: "declining", tone: "er", ar: "كمياتهم نقصت", en: "Ordering less" },
  { f: "contracts", tone: "sig", ar: "تنتهي قريب", en: "Ending soon" },
];

export function MyBookPanel({ data, ar, active, onPick }: { data: MyBook; ar: boolean; active: BookFilter | null; onPick: (f: BookFilter | null) => void }) {
  const count = (f: BookFilter) => data.book.filter((r) => inFilter(r, f)).length;
  const groups = data.tiers.groups.filter((g) => g.count > 0);
  const tierTone: Record<BookTier, string> = { VIP: "vip", REGULAR: "reg", SMALL: "small", QUIET: "quiet" };
  return (
    <section className="cu-book" aria-label={ar ? "ملخص عملائي" : "My book"} data-testid="my-book">
      <div className="cu-book-tiles" role="group" aria-label={ar ? "صفّ القائمة حسب" : "Filter the list by"}>
        {TILES.map((t) => {
          const n = count(t.f);
          const on = active === t.f;
          return (
            <button key={t.f} type="button" className={`cu-book-tile ${t.tone}${on ? " on" : ""}`} aria-pressed={on}
              onClick={() => onPick(on ? null : t.f)} data-testid={`book-tile-${t.f}`}>
              <span className="lbl"><i aria-hidden />{filterLabel(t.f, ar)}</span>
              <b className="num">{n}</b>
              <small>{ar ? t.ar : t.en}</small>
            </button>
          );
        })}
      </div>
      {data.tiers.totalKg > 0 ? (
        <div className="cu-book-tiers" data-testid="book-tiers">
          <div className="cu-book-tiers-h">
            <b>{ar ? "تصنيف عملائي حسب الكمية (آخر 3 شهور)" : "My customers by volume (last 3 months)"}</b>
            <span>{ar ? "اضغط أي تصنيف يصفّي القائمة" : "Tap a tier to filter the list"}</span>
          </div>
          <div className="cu-book-bar" role="img" aria-label={groups.map((g) => `${TIER_LABEL[g.tier][ar ? 0 : 1]} ${g.share}%`).join("، ")}>
            {groups.filter((g) => g.share > 0).map((g) => <span key={g.tier} className={tierTone[g.tier]} style={{ flexGrow: g.share }} />)}
          </div>
          <div className="cu-book-tierchips">
            {groups.map((g) => {
              const f = `tier-${g.tier}` as BookFilter;
              const on = active === f;
              return (
                <button key={g.tier} type="button" className={`cu-book-chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => onPick(on ? null : f)} data-testid={`book-${f}`}>
                  <i className={tierTone[g.tier]} aria-hidden /><b>{TIER_LABEL[g.tier][ar ? 0 : 1]}</b>
                  <span>{ar ? `${g.count} ${g.count === 1 ? "عميل" : "عملاء"}${g.tier !== "QUIET" ? ` · ${g.share}%` : ""}` : `${g.count} · ${g.share}%`}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
