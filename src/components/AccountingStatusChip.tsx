"use client";

// The accounting state of operational records (purchases, roasts, packing, dispatches), shown on
// the operational screens: each stock change becomes an inventory document automatically, and
// anything that could not post is visible here and in the accounting exception queue.
// Status and reason only — no amounts. Hidden when the viewer has no access.
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

type Entry = { kind: string; status: string; reason: string | null };
type StatusMap = Record<string, Entry[]>;

export function useAccountingStatus(ids: string[]) {
  const key = useMemo(() => [...new Set(ids.filter(Boolean))].sort().join(","), [ids]);
  const [map, setMap] = useState<StatusMap>({});
  useEffect(() => {
    if (!key) return;
    let live = true;
    const chunks = key.split(",").reduce<string[][]>((acc, id, i) => { (acc[Math.floor(i / 200)] ??= []).push(id); return acc; }, []);
    Promise.all(chunks.map((c) => fetch(`/api/inventory/accounting-status?ids=${encodeURIComponent(c.join(","))}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))))
      .then((parts) => { if (live) setMap(Object.assign({}, ...parts)); });
    return () => { live = false; };
  }, [key]);
  return map;
}

const LABEL: Record<string, { ar: string; en: string; cls: string }> = {
  POSTED: { ar: "مُرحّل محاسبياً", en: "In the accounts", cls: "bg-green-50 text-green-800 border-green-200" },
  HELD: { ar: "بانتظار المحاسب", en: "Awaiting accountant", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  PENDING: { ar: "قيد الترحيل", en: "Posting", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  PROCESSING: { ar: "قيد الترحيل", en: "Posting", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  FAILED: { ar: "إعادة المحاولة", en: "Retrying", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  BLOCKED: { ar: "استثناء محاسبي", en: "Accounting exception", cls: "bg-red-50 text-red-800 border-red-200" },
  IGNORED: { ar: "لا أثر محاسبي", en: "No accounting effect", cls: "bg-cream text-brown border-border" },
};
const RANK = ["BLOCKED", "FAILED", "HELD", "PROCESSING", "PENDING", "IGNORED", "POSTED"];

/** One chip for a record: the most urgent state of its events, the reason on hover and for screen readers. */
export function AccountingStatusChip({ entries }: { entries?: Entry[] }) {
  const { lang } = useI18n();
  if (!entries?.length) return null;
  const worst = [...entries].sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status))[0];
  const l = LABEL[worst.status] ?? { ar: worst.status, en: worst.status, cls: "bg-cream text-brown border-border" };
  const text = lang === "ar" ? l.ar : l.en;
  return (
    <span title={worst.reason ?? undefined} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${l.cls}`}>
      {text}
      {worst.reason && worst.status !== "POSTED" && <span className="sr-only">: {worst.reason}</span>}
    </span>
  );
}
