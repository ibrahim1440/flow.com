"use client";
// Settings › Production & roasting › Roasters — the pieces the five screens share (Figma 377:2:
// RM1 387:182, RM2 389:640, RM3 391:1012, RM4 393:1398, RM4b 395:1701, RM5 397:2052; phones 378:2,
// 379:49, 382:89, 384:104). Presentation and requests only; every rule is the API's
// (/api/settings/production…, ROASTERS.md §4–§7).
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { dateTimeIn } from "@/components/hr/ui";
import { Btn, Dot, PageHeader, type Tone } from "@/components/ops/ui";
import { Ico } from "@/components/shell/icons";
import { usePhone } from "@/components/shell/page-context";
import { LinkTabs } from "../../../_components/tools-ui";
import "../../_parts/sections.css";

export type Roaster = {
  id: string; name: string; manufacturerModel: string | null; type: "PRODUCTION" | "SAMPLE";
  nominalCapacityKg: string; defaultTargetKg: string; minBatchKg: string; maxBatchKg: string; cycleMinutes: number;
  defaultOperatorId: string | null; defaultOperatorName: string | null;
  status: "AVAILABLE" | "MAINTENANCE" | "STOPPED" | "RETIRED"; statusReason: string | null; statusUntil: string | null; statusSince: string;
  isDefault: boolean; createdAt: string; updatedAt: string;
};
export type Maintenance = {
  id: string; roasterId: string; title: string; kind: "ROUTINE" | "ONE_OFF"; recurrenceWeeks: number | null;
  startsAt: string; endsAt: string; status: "PLANNED" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  requestedById: string | null; requestedByName: string | null; notes: string | null; updatedAt: string;
};
export type Person = { id: string; name: string; authorized: boolean };
export type Overview = { people: Person[]; roasters: Roaster[]; maintenance: Maintenance[]; nextMaintenance: Maintenance | null; can: { edit: boolean } };
export type FieldError = { field: string; ar: string; en: string; summaryAr: string; summaryEn: string };
export type HistoryRow = { id: string; action: string; changed: string[]; before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null; actorName: string | null; createdAt: string; names: Record<string, string> };
export type ApiError = { error?: string; errorEn?: string; code?: string; fields?: FieldError[]; currentDefault?: { id: string; name: string } };

export const BASE = "/dashboard/settings/production";

export function useLang() {
  const { lang } = useI18n();
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  return { lang: lang as "ar" | "en", ar, L };
}

/** JSON request; the dashboard's fetch wrapper handles a step-up (401 REAUTH_REQUIRED) and retries once. */
export async function call<T>(url: string, method = "GET", body?: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; data: ApiError }> {
  try {
    const r = await fetch(url, { method, cache: "no-store", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data: data as T } : { ok: false, status: r.status, data: data as ApiError };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

export function errText(d: ApiError, ar: boolean, fallbackAr = "تعذّر الحفظ. لم يتغير شيء.", fallbackEn = "Could not save. Nothing was changed.") {
  return (ar ? d.error : d.errorEn ?? d.error) ?? (ar ? fallbackAr : fallbackEn);
}

/** The overview (roasters, maintenance), reloaded on demand. */
export function useOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [token, setToken] = useState(0);
  const reload = useCallback(() => setToken((t) => t + 1), []);
  useEffect(() => {
    let off = false;
    call<Overview>("/api/settings/production").then((r) => {
      if (off) return;
      if (r.ok) { setData(r.data); setError(null); } else setError(r.data);
    });
    return () => { off = true; };
  }, [token]);
  return { data, error, reload };
}

// ── Wording ──────────────────────────────────────────────────────────────────────────

export const STATUS: Record<Roaster["status"], [string, string, Tone]> = {
  AVAILABLE: ["متاحة", "Available", "success"],
  MAINTENANCE: ["في الصيانة", "In maintenance", "warning"],
  STOPPED: ["متوقفة", "Stopped", "danger"],
  RETIRED: ["خارج الخدمة", "Retired", "cancelled"],
};
export const M_STATUS: Record<Maintenance["status"], [string, string, Tone]> = {
  PLANNED: ["مخططة", "Planned", "neutral"],
  IN_PROGRESS: ["جارية", "In progress", "warning"],
  DONE: ["مكتملة", "Done", "success"],
  CANCELLED: ["ملغاة", "Cancelled", "cancelled"],
};
export const TYPE: Record<Roaster["type"], [string, string]> = { PRODUCTION: ["إنتاج", "Production"], SAMPLE: ["عينات", "Sample"] };

export function StatusText({ status, ar }: { status: Roaster["status"]; ar: boolean }) {
  const [a, e, tone] = STATUS[status];
  return <Dot tone={tone}>{ar ? a : e}</Dot>;
}

/** «6.00» as a number run (LTR-isolated inside Arabic). */
export function N({ children }: { children: ReactNode }) {
  return <bdi dir="ltr" className="hr-num">{children}</bdi>;
}

/** Arabic count of production roasters: «محمصة إنتاج واحدة مسجّلة», «محمصتا إنتاج مسجّلتان», «3 محامص إنتاج مسجّلة». */
export function productionCount(n: number, ar: boolean): string {
  if (!ar) return n === 0 ? "No production roaster registered" : n === 1 ? "1 production roaster registered" : `${n} production roasters registered`;
  if (n === 0) return "لا محمصة إنتاج مسجّلة";
  if (n === 1) return "محمصة إنتاج واحدة مسجّلة";
  if (n === 2) return "محمصتا إنتاج مسجّلتان";
  if (n <= 10) return `${n} محامص إنتاج مسجّلة`;
  return `${n} محمصة إنتاج مسجّلة`;
}

const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The calendar day in Riyadh as {y, m, d, dow}. */
export function riyadhDay(iso: string | Date) {
  const s = dateTimeIn(iso);
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), key: s.slice(0, 10), time: s.slice(11, 16) };
}

/** «الخميس 8 أكتوبر» / "Thursday 8 October". */
export function dayLabel(iso: string | Date, ar: boolean, weekday = true): string {
  const x = riyadhDay(iso);
  const w = weekday ? `${ar ? AR_DAYS[x.dow] : EN_DAYS[x.dow]} ` : "";
  return `${w}${x.d} ${ar ? AR_MONTHS[x.m - 1] : EN_MONTHS[x.m - 1]}`;
}
export const weekdayName = (dow: number, ar: boolean) => (ar ? AR_DAYS[dow] : EN_DAYS[dow]);
export const monthDay = (d: number, m: number, ar: boolean) => `${d} ${ar ? AR_MONTHS[m - 1] : EN_MONTHS[m - 1]}`;
export const timeOf = (iso: string) => riyadhDay(iso).time;
/** «13:00–14:00», the end's date added when the window crosses a day. */
export function windowText(m: { startsAt: string; endsAt: string }, ar: boolean): string {
  const a = riyadhDay(m.startsAt), b = riyadhDay(m.endsAt);
  return a.key === b.key ? `${a.time}–${b.time}` : `${a.time} – ${dayLabel(m.endsAt, ar, false)} ${b.time}`;
}
/** «1 أكتوبر 09:10». */
export const stamp = (iso: string, ar: boolean) => `${dayLabel(iso, ar, false)} ${timeOf(iso)}`;

/** A maintenance window's «النوع» column: «دورية · كل أسبوعين», «دورية», «بطلب …», «لمرة واحدة». */
export function kindText(m: Maintenance, ar: boolean): string {
  if (m.kind === "ROUTINE") {
    const every = m.recurrenceWeeks
      ? ar ? (m.recurrenceWeeks === 1 ? "كل أسبوع" : m.recurrenceWeeks === 2 ? "كل أسبوعين" : `كل ${m.recurrenceWeeks} أسابيع`) : m.recurrenceWeeks === 1 ? "every week" : `every ${m.recurrenceWeeks} weeks`
      : null;
    return [ar ? "دورية" : "Routine", every].filter(Boolean).join(" · ");
  }
  if (m.requestedByName) return ar ? `بطلب ${m.requestedByName}` : `Requested by ${m.requestedByName}`;
  return ar ? "لمرة واحدة" : "One-off";
}

/** The heading of the three tab pages (RM1 / RM4 / RM5): title, meta, «إضافة محمصة», the tabs. */
export function RoastersHead({ tab, data, add }: { tab: "list" | "avail" | "ops"; data: Overview | null; add?: boolean }) {
  const { ar, L } = useLang();
  // The phone frames (378:2) draw the list alone under the phone header — its «+» adds — with no tabs.
  const phone = usePhone();
  const production = data?.roasters.filter((r) => r.type === "PRODUCTION").length ?? 0;
  const all = data?.roasters.length;
  return (
    <>
      <PageHeader
        title={L("إدارة المحامص", "Roaster management")}
        actions={add && data?.can.edit && !phone ? (
          <Link href={`${BASE}/roasters/new`} className="hr-btn is-primary" data-testid="roaster-add"><Ico name="plus" small />{L("إضافة محمصة", "Add roaster")}</Link>
        ) : null}
      />
      <p className="tl-sub">
        {L("الإعدادات · الإنتاج والتحميص", "Settings · Production & roasting")}
        {data ? <><span className="tl-sep">•</span>{productionCount(production, ar)}</> : null}
      </p>
      {phone && tab === "list" ? null : <LinkTabs
        label={L("إدارة المحامص", "Roaster management")}
        items={[
          { href: BASE, label: L("المحامص", "Roasters"), count: all, current: tab === "list", testId: "rm-tab-list" },
          { href: `${BASE}/availability`, label: L("التوفر والصيانة", "Availability & maintenance"), current: tab === "avail", testId: "rm-tab-avail" },
          { href: `${BASE}/operators`, label: L("المشغّلون", "Operators"), current: tab === "ops", testId: "rm-tab-ops" },
        ]}
      />}
    </>
  );
}

/** The frame's footnote under the lists (RM1): capacity is for planning and validation only. */
export function CapacityNote({ short }: { short?: boolean }) {
  const { L } = useLang();
  return (
    <p className={`tl-note${short ? " ss-plain" : ""}`} data-testid="capacity-note">
      {short
        ? L("السعة للتخطيط والتحقق فقط. الفاقد من الأوزان المسجّلة.", "Capacity is for planning and validation only. Loss comes from recorded weights.")
        : L("تُستخدم السعة والحدود للتخطيط والتحقق فقط. الفاقد والمحمص يُحسبان دائمًا من الأوزان المسجّلة لكل دفعة، ولا يُشتقّان من سعة المحمصة.",
          "Capacity and limits are used for planning and validation only. Loss and roasted weight always come from each batch's recorded weights, never from the roaster's capacity.")}
    </p>
  );
}

/** The read-only notice for a production viewer who cannot change the configuration. */
export function ReadOnlyNote() {
  const { L } = useLang();
  return <p className="tl-foot" data-testid="rm-readonly">{L("للعرض فقط · يغيّر الإعداد المدير", "Read only · the administrator changes the configuration")}</p>;
}

/** «Segmented» radio group (the frame's seg). */
export function Seg<K extends string>({ value, options, onChange, label, disabled, testId }: { value: K; options: [K, string][]; onChange: (k: K) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <div className="tl-seg" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map(([k, text]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} disabled={disabled} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

/** «تعذّر الحفظ: 3 حقول تحتاج تصحيحًا» and the list (RM2); on a phone the count line alone (379:49). */
export function ErrorSummary({ errors, phone }: { errors: FieldError[]; phone?: boolean }) {
  const { ar } = useLang();
  if (errors.length === 0) return null;
  const n = errors.length;
  const count = ar
    ? n === 1 ? "حقل واحد يحتاج تصحيحًا" : n === 2 ? "حقلان يحتاجان تصحيحًا" : n <= 10 ? `${n} حقول تحتاج تصحيحًا` : `${n} حقلًا يحتاج تصحيحًا`
    : n === 1 ? "1 field needs correcting" : `${n} fields need correcting`;
  return (
    <div className="ss-errsum" role="alert" data-testid="error-summary">
      <strong>{phone ? count : ar ? `تعذّر الحفظ: ${count}` : `Could not save: ${count}`}</strong>
      {phone ? null : <ul>{errors.map((e) => <li key={e.field}>{ar ? e.summaryAr : e.summaryEn}</li>)}</ul>}
    </div>
  );
}

export function Plus() { return <Ico name="plus" small />; }

export function Retry({ onRetry, error }: { onRetry: () => void; error: ApiError }) {
  const { ar, L } = useLang();
  return (
    <div className="hr-notice tone-danger" role="alert" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span><strong>{L("تعذّر التحميل.", "Could not load.")}</strong> {errText(error, ar, "", "")}</span>
      <Btn size="sm" onClick={onRetry}>{L("إعادة المحاولة", "Try again")}</Btn>
    </div>
  );
}
