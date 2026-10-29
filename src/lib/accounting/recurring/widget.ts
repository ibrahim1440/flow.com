// «تفاصيل المعاملات المتكررة» — the dashboard widget's data (Qoyod's dashboard; drawn by the accountant workspace,
// builder qa-shell). Read-only. Tabs: ALL («الكل»), SALES_INVOICE («فواتير المبيعات»), PURCHASE_INVOICE («فواتير
// المشتريات») and SIMPLE_BILL («فواتير بسيطة») — the last two are phase 2 (shared.ts, PHASE_2_REASON): they answer
// no rows and `supported: false`. «الكل» lists every recurring transaction, journals included. Columns: المرجع،
// الإسم، تاريخ الإنشاء، تاريخ التكرار التالي، الحالة، الخيارات (the options are links the viewer's route guard decides).
// Documented in qoyod-program/APIS.md.
import { prisma } from "@/lib/db";
import { failedRunCounts } from "./schedules";
import { dayText, riyadhDay } from "../dates";
import { KIND_LABEL, PHASE_2_REASON, STATUS_LABEL, WIDGET_KINDS, refText, type RecurringKind, type RecurringStatus } from "./shared";

export const WIDGET_TABS = ["ALL", "SALES_INVOICE", "PURCHASE_INVOICE", "SIMPLE_BILL"] as const;
export type WidgetTab = (typeof WIDGET_TABS)[number];

export type RecurringWidgetRow = {
  id: string;
  /** المرجع — REC-000001 */
  ref: string;
  /** الإسم */
  name: string;
  kind: RecurringKind;
  kindLabel: { ar: string; en: string };
  /** تاريخ الإنشاء — ISO instant */
  createdAt: string;
  /** تاريخ التكرار التالي — YYYY-MM-DD, null when completed / cancelled */
  nextRunDate: string | null;
  /** due on / before today (Asia/Riyadh) and still active */
  overdue: boolean;
  /** الحالة */
  status: RecurringStatus;
  statusLabel: { ar: string; en: string };
  /** FAILED runs of this transaction waiting for «إعادة المحاولة» (a badge on the row). */
  failedRuns: number;
  /** الخيارات */
  links: { view: string; history: string };
};

export type RecurringWidget = {
  tab: WidgetTab;
  tabs: { key: WidgetTab; ar: string; en: string; supported: boolean; count: number }[];
  rows: RecurringWidgetRow[];
  total: number;
  take: number;
  skip: number;
  /** Set when the tab is not built yet (purchase invoices / simple bills). */
  notSupported: { ar: string; en: string } | null;
  /** Active schedules due now (for a badge; «تشغيل المستحق الآن» on the recurring page runs them). */
  dueNow: number;
  /** FAILED runs waiting for «إعادة المحاولة», over every transaction not cancelled (the dashboard's badge). */
  failedRuns: number;
};

/**
 * The widget's rows for a tab, newest first, paged (`take` 1–50, default 5 — the dashboard card; «السابق / التالي»).
 * Statuses: ACTIVE / PAUSED first is not imposed — Qoyod lists by creation; `status` filters when given.
 */
export async function recurringWidget(opts: { tab?: string | null; take?: number; skip?: number; status?: string | null } = {}): Promise<RecurringWidget> {
  const tab = (WIDGET_TABS as readonly string[]).includes(String(opts.tab)) ? (opts.tab as WidgetTab) : "ALL";
  const take = Math.min(Math.max(Math.trunc(opts.take ?? 5) || 5, 1), 50), skip = Math.max(Math.trunc(opts.skip ?? 0) || 0, 0);
  const status = opts.status && ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"].includes(opts.status) ? opts.status : null;
  const supported = tab === "ALL" || tab === "SALES_INVOICE";
  const where = { ...(tab === "SALES_INVOICE" ? { kind: "SALES_INVOICE" } : {}), ...(status ? { status } : {}) };
  const today = riyadhDay();
  const [rows, total, byKind, dueNow, failed] = await Promise.all([
    supported ? prisma.recurringSchedule.findMany({ where, orderBy: [{ createdAt: "desc" }, { refNo: "desc" }], take, skip, select: { id: true, refNo: true, name: true, kind: true, createdAt: true, nextRunDate: true, status: true } }) : Promise.resolve([]),
    supported ? prisma.recurringSchedule.count({ where }) : Promise.resolve(0),
    prisma.recurringSchedule.groupBy({ by: ["kind"], where: status ? { status } : {}, _count: { _all: true } }),
    prisma.recurringSchedule.count({ where: { status: "ACTIVE", nextRunDate: { lte: today } } }),
    failedRunCounts(),
  ]);
  const count = (k: string) => byKind.find((b) => b.kind === k)?._count._all ?? 0;
  const all = byKind.reduce((s, b) => s + b._count._all, 0);
  return {
    tab, take, skip, total, dueNow, failedRuns: failed.total,
    tabs: [
      { key: "ALL", ar: "الكل", en: "All", supported: true, count: all },
      ...WIDGET_KINDS.map((w) => ({ key: w.key as WidgetTab, ar: w.ar, en: w.en, supported: w.supported, count: w.supported ? count(w.key) : 0 })),
    ],
    notSupported: supported ? null : PHASE_2_REASON,
    rows: rows.map((r) => {
      const kind = r.kind as RecurringKind, st = r.status as RecurringStatus;
      return {
        id: r.id, ref: refText(r.refNo), name: r.name, kind, kindLabel: { ar: KIND_LABEL[kind][0], en: KIND_LABEL[kind][1] },
        createdAt: r.createdAt.toISOString(), nextRunDate: r.nextRunDate ? dayText(r.nextRunDate) : null,
        overdue: st === "ACTIVE" && !!r.nextRunDate && r.nextRunDate <= today,
        status: st, statusLabel: { ar: STATUS_LABEL[st][0], en: STATUS_LABEL[st][1] }, failedRuns: failed.bySchedule.get(r.id) ?? 0,
        links: { view: `/dashboard/accounting/recurring/${r.id}`, history: `/dashboard/accounting/recurring/${r.id}#runs` },
      };
    }),
  };
}
