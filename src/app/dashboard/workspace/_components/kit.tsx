"use client";
import { useWsBadge } from "@/lib/workspace/badge-client";
// «مساحة عملي» — the shared client kit: the page frame with its tabs, the chips, the API types.
// Built on the HR / ops kits (Direction 2.1); every rule is re-checked by /api/workspace/*.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useD21Phone } from "@/components/shell/page-context";
import { OpsRoot, PageHeader, useL } from "@/components/ops/ui";
import { HrApiError, useHr } from "@/components/hr/ui";
import { localizeApiError } from "@/lib/i18n/api-errors";
import { useI18n } from "@/lib/i18n/context";
import { STATUS_LABEL, PRIORITY_LABEL, type TaskStatus, type Priority } from "@/lib/workspace/rules";
import { dueLabel, overdueBy } from "@/lib/workspace/format";

export { useHr as useWs };

/**
 * A JSON call to any ERP endpoint. The workspace calls the departments' own endpoints (HR answers
 * `error` in Arabic, Sales / Finance answer English with `errorAr`), so the refusal is read with the
 * ERP-wide rule (localizeApiError): Arabic first for an Arabic page, the code kept for the screens.
 */
export async function wsFetch<T = unknown>(url: string, init?: { method?: string; json?: unknown; form?: FormData }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.json !== undefined || init?.form ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.form ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined),
    cache: "no-store",
  });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.json().catch(() => ({})) : null;
  if (!res.ok) throw new HrApiError(localizeApiError(body) ?? `HTTP ${res.status}`, res.status, (body as { code?: string } | null)?.code ?? null);
  return body as T;
}

// ── API shapes (lib/workspace/server/*) ────────────────────────────────────────────────

export type Person = { id: string; name: string };
export type Task = {
  id: string; kind: "TASK" | "FOLLOW_UP"; title: string; description: string | null; status: TaskStatus; holdReason: string | null; priority: Priority;
  assigneeId: string; createdById: string; reviewerId: string | null; requiresReview: boolean; dueAt: string; dueBasis: string;
  plannedStartAt: string | null; plannedMinutes: number | null; remindBeforeMinutes: number | null; channel: string | null;
  customerId: string | null; leadId: string | null; opportunityId: string | null; refType: string | null; refId: string | null; refLabel: string | null; occasionId: string | null;
  resultActivityId: string | null; recurRule: string | null; recurInterval: number | null; completedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  version: number; createdAt: string;
  assignee: Person & { active: boolean }; createdBy: Person; reviewer: Person | null;
  customer: Person | null; lead: { id: string; companyName: string; contactName: string } | null; opportunity: { id: string; title: string } | null; occasion: Person | null;
  watchers: { employeeId: string; employee: { name: string } }[];
  overdue: boolean; completedLate: boolean; bucket: "OVERDUE" | "TODAY" | "TOMORROW" | "THIS_WEEK" | "LATER" | null;
  roles: string[]; actions: string[];
};
export type ApprovalItem = {
  key: string; type: "LEAVE" | "ADVANCE" | "DISCOUNT" | "FINANCE" | "MARKETING"; id: string; title: string; requester: string | null; subject: string | null; createdAt: string;
  facts: Record<string, unknown>; warnings: { ar: string; en: string }[];
  decide: { url: string; rejectNeedsReason: true; expected?: Record<string, string>; stepUp?: boolean };
  openUrl: string; notice?: { ar: string; en: string };
};
export type Appointment = {
  id: string; kind: "MEETING" | "VISIT" | "CALL" | "OTHER"; title: string; notes: string | null; startAt: string; endAt: string; location: string | null; meetingUrl: string | null;
  externalAttendees: string | null; organizerId: string; status: "SCHEDULED" | "DONE" | "CANCELLED"; customerId: string | null; leadId: string | null; opportunityId: string | null;
  remindBeforeMinutes: number | null; version: number; organizer: Person; customer: Person | null; lead: { id: string; companyName: string } | null; opportunity: { id: string; title: string } | null;
  participants: { employeeId: string; employee: { name: string } }[]; past: boolean; actions: string[];
};
export type CrmDue = { id: string; type: string; subject: string; dueAt: string; record: string | null; openUrl: string };

// ── Words ──────────────────────────────────────────────────────────────────────────────

export const TYPE_LABEL: Record<string, [string, string]> = {
  TASK: ["مهمة", "Task"], FOLLOW_UP: ["متابعة عميل", "Follow-up"], APPROVAL: ["اعتماد", "Approval"], APPOINTMENT: ["موعد", "Appointment"], CRM: ["متابعة", "Follow-up"],
  LEAVE: ["إجازة", "Leave"], ADVANCE: ["سلفة", "Advance"], CORRECTION: ["تصحيح", "Correction"], DISCOUNT: ["خصم", "Discount"], FINANCE: ["مالية", "Finance"], MARKETING: ["تسويق", "Marketing"],
  MEETING: ["اجتماع", "Meeting"], VISIT: ["زيارة", "Visit"], CALL: ["مكالمة", "Call"], OTHER: ["موعد", "Appointment"],
};
export const OUTCOMES: [string, string, string][] = [
  ["NO_ANSWER", "لم يرد", "No answer"], ["LEFT_MESSAGE", "تُركت رسالة", "Left a message"], ["INTERESTED", "مهتم", "Interested"],
  ["MEETING_COMPLETED", "تم الاجتماع", "Meeting held"], ["VISIT_COMPLETED", "تمت الزيارة", "Visit done"], ["FOLLOW_UP_REQUIRED", "يحتاج متابعة", "Needs follow-up"],
  ["NOT_INTERESTED", "غير مهتم", "Not interested"],
];

export function useLang() {
  const { lang } = useI18n();
  return lang === "en" ? "en" : "ar";
}

/** Re-render every minute so «متأخرة» and «الآن» stay true while the page is open. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ── Chips ──────────────────────────────────────────────────────────────────────────────

export function TypeChip({ type }: { type: string }) {
  const lang = useLang();
  const [ar, en] = TYPE_LABEL[type] ?? [type, type];
  return <span className={`ws-type is-${type.toLowerCase()}`}>{lang === "ar" ? ar : en}</span>;
}

export function StatusChip({ status }: { status: TaskStatus }) {
  const lang = useLang();
  const s = STATUS_LABEL[status];
  return <span className={`hr-dot tone-${s.tone}`}><span>{lang === "ar" ? s.ar : s.en}</span></span>;
}

export function PriorityMark({ priority }: { priority: Priority }) {
  const lang = useLang();
  if (priority !== "URGENT" && priority !== "HIGH") return null;
  const p = PRIORITY_LABEL[priority];
  return <span className={`hr-flag tone-${priority === "URGENT" ? "warning" : "info"}`}><span>{lang === "ar" ? p.ar : p.en}</span></span>;
}

/** The deadline as text — overdue in danger colour AND words (never colour alone). */
export function DueText({ dueAt, overdue, now }: { dueAt: string; overdue?: boolean; now: Date }) {
  const lang = useLang();
  if (overdue) return <span className="ws-due is-overdue"><span aria-hidden="true">●</span> {overdueBy(dueAt, lang, now)}</span>;
  return <span className="ws-due">{dueLabel(dueAt, lang, now)}</span>;
}

/** The linked record of a task, as words. */
export function recordOf(t: Pick<Task, "customer" | "lead" | "opportunity" | "refLabel" | "occasion">): string | null {
  return t.customer?.name ?? t.opportunity?.title ?? (t.lead ? `${t.lead.companyName}` : null) ?? t.refLabel ?? t.occasion?.name ?? null;
}

// ── The page frame ────────────────────────────────────────────────────────────────────

// «مساحة عملي» is for work. The person's own HR requests (leave, advances, corrections) are submitted and
// followed in «خدماتي» (/dashboard/me#requests); «اليوم» shows only a compact card of the pending ones,
// and the old /dashboard/workspace/requests redirects there (next.config.ts).
type TabKey = "today" | "tasks" | "approvals" | "calendar" | "team";
const TABS: { key: TabKey; href: string; ar: string; en: string }[] = [
  { key: "today", href: "/dashboard/workspace", ar: "اليوم", en: "Today" },
  { key: "tasks", href: "/dashboard/workspace/tasks", ar: "مهامي", en: "My tasks" },
  { key: "approvals", href: "/dashboard/workspace/approvals", ar: "بانتظار اعتمادي", en: "Pending my approval" },
  { key: "calendar", href: "/dashboard/workspace/calendar", ar: "التقويم", en: "Calendar" },
  { key: "team", href: "/dashboard/workspace/team", ar: "الفريق", en: "Team" },
];

/**
 * The scope every workspace screen sits in: OpsRoot (the HR / ops tokens — the panes and dialogs need
 * them too) around the split of the page and its side pane.
 */
export function WsShell({ open, wide, children }: { open?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <OpsRoot wide={wide} className="ws-root">
      <div className={`hr-split${open ? " has-preview" : ""}`}>{children}</div>
    </OpsRoot>
  );
}

/** The workspace page: title, the five pages as tabs (the team only for a team), the content. */
export function WsPage({ title, sub, actions, children, testId }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
  const L = useL();
  const pathname = usePathname();
  const badge = useWsBadge(true, pathname);
  useD21Phone({ title });
  const tabs = TABS.filter((t) => t.key !== "team" || badge?.hasTeam);
  const current = [...tabs].sort((a, b) => b.href.length - a.href.length).find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))?.key;
  return (
      <div className="hr-page ws-page" data-testid={testId}>
        <PageHeader title={title} actions={actions}>{sub}</PageHeader>
        <nav className="ws-tabs" aria-label={L("صفحات مساحة عملي", "My Workspace pages")}>
          <ul>
            {tabs.map((t) => (
              <li key={t.key}>
                <Link href={t.href} aria-current={current === t.key ? "page" : undefined} data-testid={`ws-tab-${t.key}`}>
                  {L(t.ar, t.en)}
                  {t.key === "approvals" && badge?.approvals ? <span className="hr-count" aria-label={L(`${badge.approvals} بانتظار قرارك`, `${badge.approvals} waiting`)}>{badge.approvals}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {children}
      </div>
  );
}

/** The panes keep the page's list, search, filters and scroll: selection lives in the URL (?task=). */
export function useSelection(param: string) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setId(new URLSearchParams(window.location.search).get(param));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [param]);
  const set = (next: string | null) => {
    const u = new URL(window.location.href);
    if (next) u.searchParams.set(param, next); else u.searchParams.delete(param);
    // replaceState: no navigation, no re-render of the list, no scroll jump.
    window.history.replaceState(window.history.state, "", u.toString());
    setId(next);
  };
  return [id, set] as const;
}
