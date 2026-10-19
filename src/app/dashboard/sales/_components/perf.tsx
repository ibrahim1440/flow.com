"use client";

import { Select } from "@/components/ui/Select";
import Link from "next/link";
import type { ReactNode } from "react";
import { useSectionPages, usePhone, useD21Phone } from "@/components/shell/page-context";
import { monthOptions, ACCRUAL_STATUS_SPECS } from "./ui";

/**
 * The shared frame of «الأداء والعمولات» in Direction 2.1 (GX A-P03…A-P07: targets `1220:94392`,
 * sales reports `1222:100243`, my commissions `1225:3172`, commission review `1228:103105`,
 * commission plans `1228:113728`), and the small pieces those pages share with sales settings
 * (`1229:114164`).
 *
 * Every frame of the family draws the same page header — «الأداء والعمولات», a line of facts,
 * the period chip and the page's own action — over a row of tabs, one per page of the section.
 * The tabs are the registry's own pages of `finance.performance` as the shell already resolves
 * them for this viewer (`useSectionPages`), so a tab is never shown to someone the sidebar would
 * not show it to, and nothing here adds a destination. «لوحة الأداء» and «التحليلات التنبؤية» in
 * the frames have no route in this family yet and are not drawn (see the batch report).
 *
 * Visual only: no page's data, request or permission check changes by using these.
 */

/** The page header of the family (`.ph`), with the section's tabs under it. */
export function PerfHeader({
  title, meta, actions, phoneTitle, ar,
}: {
  title: string;
  meta: ReactNode[];
  actions?: ReactNode;
  /** On a phone the frames name the PAGE in the header and the section under it (390c/390d). */
  phoneTitle: string;
  ar: boolean;
}) {
  const phone = usePhone();
  const section = ar ? "الأداء والعمولات" : "Performance and commissions";
  useD21Phone({ title: phoneTitle, sub: title === phoneTitle ? undefined : section });
  if (phone) {
    return (
      <div className="perf-ph">
        {actions && <div className="perf-ph-act">{actions}</div>}
        {meta.length > 0 && (
          <div className="perf-ph-meta">
            {meta.map((m, i) => <span key={i}>{m}</span>)}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="ph" style={{ marginBottom: 20 }}>
        <div style={{ minWidth: 0 }}>
          <h1>{title}</h1>
          {meta.length > 0 && (
            <div className="meta">
              {meta.map((m, i) => (
                <span key={i} style={{ display: "contents" }}>{i > 0 && <i aria-hidden />}<span>{m}</span></span>
              ))}
            </div>
          )}
        </div>
        {actions && <div className="act">{actions}</div>}
      </div>
      <PerfTabs ar={ar} />
    </>
  );
}

/** The section's pages as the frame's underline tabs (direction.css `.tabs`). Links, not
 *  buttons: each is its own URL, exactly the destinations of the sidebar. */
export function PerfTabs({ ar }: { ar: boolean }) {
  const s = useSectionPages();
  if (!s) return null;
  return (
    <nav aria-label={ar ? "صفحات الأداء والعمولات" : "Performance and commissions pages"} data-testid="perf-tabs">
      <div className="tabs">
        {s.pages.map((p) => (
          <Link key={p.id} href={p.href} className={p.current ? "on" : undefined}
            aria-current={p.current ? "page" : undefined} data-testid={`perf-tab-${p.id}`}>
            {p.text}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** The period chip of the frames («الشهر سبتمبر 2026») — a real select in the chip's place, so
 *  every month the screen offered before is still on offer. */
export function MonthChip({
  value, onChange, lang, testId, label,
}: {
  value: string;
  onChange: (v: string) => void;
  lang: "ar" | "en";
  testId: string;
  label?: string;
}) {
  const ar = lang === "ar";
  const word = label ?? (ar ? "الشهر" : "Month");
  return (
    <label className="chip perf-chip">
      <span>{word}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={word} data-testid={testId}>
        {monthOptions(value, lang).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
      <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
    </label>
  );
}

/** The figure bar of the frames (`.bar`): a 6px track, filled from the reading edge. */
export function Bar({ percent, label, testId }: { percent: number; label?: string; testId?: string }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <div className="bar" role={label ? "progressbar" : undefined} aria-valuenow={label ? Math.round(percent) : undefined}
      aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined} aria-label={label} data-testid={testId}>
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** The grey explanatory note that closes each frame. */
export function PerfNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="perf-note" data-testid={testId}>{children}</div>;
}

/** An error or a confirmation, as the reference `.notice` (same test ids and roles as before). */
export function PerfNotice({
  kind, children, onDismiss, ar,
}: { kind: "error" | "success"; children: ReactNode; onDismiss?: () => void; ar: boolean }) {
  if (!children) return null;
  return (
    <p className={`notice ${kind === "error" ? "er" : "ok"}`} role={kind === "error" ? "alert" : "status"}
      data-testid={`alert-${kind}`} style={{ marginBottom: 16 }}>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {onDismiss && <button type="button" onClick={onDismiss} aria-label={ar ? "إغلاق" : "Dismiss"}>×</button>}
    </p>
  );
}

/** The sandbox-source notice, unchanged in what it says; drawn as a warning notice. */
export function PerfSandbox({ notice, ar }: { notice?: string | null; ar: boolean }) {
  if (!notice) return null;
  return (
    <p className="notice wa" role="note" data-testid="sandbox-banner" style={{ marginBottom: 16 }}>
      <span><b style={{ fontWeight: 600 }}>{ar ? "مصدر تجريبي: " : "Sandbox source: "}</b>{notice}</span>
    </p>
  );
}

/** The centred spinner for a page still loading, inside the page's padding. */
export function PerfLoading({ ar }: { ar: boolean }) {
  return (
    <div className="pg">
      <div className="perf-loading" role="status" aria-live="polite">
        <span className="perf-spin" aria-hidden />
        <span className="sr-only">{ar ? "جارٍ التحميل" : "Loading"}</span>
      </div>
    </div>
  );
}

/** A metric strip (`.metrics`): label, figure, note. */
export function Metrics({ items, cols = 4 }: {
  items: { label: string; value: ReactNode; note?: ReactNode; testId?: string; tone?: "action" }[];
  cols?: number;
}) {
  return (
    <dl className={`metrics perf-metrics m${cols}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((m, i) => (
        <div key={i} data-testid={m.testId}>
          <dt className="lbl">{m.label}</dt>
          <dd className="mid" style={m.tone === "action" ? { color: "var(--action-primary)" } : undefined}>{m.value}</dd>
          <dd className="d">{m.note ?? ""}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An accrual's stored status as the frames' status dot: «مستحَق» waiting, «معتمَد» / «مدفوع»
 *  done, «معكوس» struck through. The words are the kit's own (ACCRUAL_STATUS_SPECS). */
const ACCRUAL_DOT: Record<string, string> = { ACCRUED: "wa", APPROVED: "ok", PAID: "ok", REVERSED: "x" };
export function AccrualDot({ status, lang, testId }: { status: string; lang: "ar" | "en"; testId?: string }) {
  const spec = ACCRUAL_STATUS_SPECS[status];
  const text = spec ? (lang === "ar" ? spec.ar : spec.en) : status;
  return <span className={`st ${ACCRUAL_DOT[status] ?? ""}`} style={{ fontSize: 12.5 }} data-testid={testId}>{text}</span>;
}
