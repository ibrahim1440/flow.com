"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Phone } from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner,
  Button, api, DataTable, Tr, Td, Toolbar, FilterSelect, ROW_ACTION, formatWhen, num,
} from "../_components/ui";

/**
 * Follow-ups — SC-09 in the Sales Screens design.
 *
 * Organised around what is late rather than around what exists. An activity list sorted by
 * creation date is a log; this is a work queue, so the counts and the default filter both
 * lead with overdue.
 *
 * The design collapses the filters behind a single "تصفية" button. They are left inline
 * here: they are the primary control on this screen, they are already wired to the server,
 * and a button that opens nothing would be worse than the extra row. Recorded in the
 * handoff as a deliberate deviation.
 *
 * PROVISIONAL INTERFACE — see the banner.
 */

type Activity = {
  id: string;
  type: string;
  subject: string;
  body: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  owner: { id: string; name: string } | null;
  lead: { id: string; companyName: string; status: string } | null;
  opportunity: { id: string; title: string; outcome: string } | null;
  customer: { id: string; name: string } | null;
};

const TYPE_LABELS: Record<string, { en: string; ar: string }> = {
  CALL: { en: "Call", ar: "مكالمة" },
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Task", ar: "مهمة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عيّنة" },
};

const FILTERS = [
  { key: "overdue", en: "Overdue", ar: "متأخرة" },
  { key: "today", en: "Due today", ar: "اليوم" },
  { key: "open", en: "All open", ar: "المفتوحة" },
  { key: "done", en: "Completed", ar: "المكتملة" },
] as const;

/**
 * "متأخّر يومان" — how late, not merely that it is late.
 *
 * Arabic counts one, two and a few differently, and a list that says "متأخّر ٢ يوم" reads as
 * machine output. The English side is a plain day count, which is what it is.
 */
function lateBy(dueAt: string, lang: "ar" | "en"): string {
  const days = Math.floor((Date.now() - new Date(dueAt).getTime()) / 86_400_000);
  if (lang !== "ar") return days < 1 ? "Overdue today" : `${days}d overdue`;
  if (days < 1) return "متأخّر اليوم";
  if (days === 1) return "متأخّر يوم";
  if (days === 2) return "متأخّر يومان";
  if (days <= 10) return `متأخّر ${num(days, "ar")} أيام`;
  return `متأخّر ${num(days, "ar")} يوماً`;
}

export default function ActivitiesPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [rows, setRows] = useState<Activity[]>([]);
  const [counts, setCounts] = useState({ overdue: 0, dueToday: 0, open: 0 });
  const [filter, setFilter] = useState<string>("open");
  const [type, setType] = useState("");
  const [scope, setScope] = useState<"own" | "all">("own");
  const [canSeeTeam, setCanSeeTeam] = useState(false);
  const [teamView, setTeamView] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /**
   * Reload counter. The fetch lives in the effect rather than a `useCallback` it calls, so the
   * first `await` precedes any state write. Completing an activity bumps this to refresh.
   * `cancelled` stops a slow response for an old filter landing after a newer one.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
    const params = new URLSearchParams({ filter });
    if (type) params.set("type", type);
    if (!teamView) params.set("scope", "mine");
    const res = await api<{
      rows: Activity[];
      counts: { overdue: number; dueToday: number; open: number };
      scope: "own" | "all";
      canSeeTeam: boolean;
    }>(`/api/sales/activities?${params}`);
    if (cancelled) return;
    if (res.ok) {
      setRows(res.data.rows);
      setCounts(res.data.counts);
      setScope(res.data.scope);
      setCanSeeTeam(res.data.canSeeTeam);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [filter, type, teamView, ar, reloadToken]);

  async function complete(id: string) {
    if (busy) return;
    setBusy(true);
    const res = await api(`/api/sales/activities/${id}`, { method: "PATCH", body: { completed: true } });
    setBusy(false);
    if (res.ok) reload();
    else setError(res.data.error ?? "");
  }

  if (loading) return <Spinner />;

  /** What a row is attached to: the deal if there is one, otherwise the lead. */
  function linkedTo(a: Activity) {
    const customer = a.customer?.name ?? a.lead?.companyName ?? null;
    if (a.opportunity) {
      return (
        <Link href={`/dashboard/sales/deals/${a.opportunity.id}`} className="hover:text-oo-action-primary">
          {customer ? `${customer} — ${a.opportunity.title}` : a.opportunity.title}
        </Link>
      );
    }
    if (a.lead) {
      return (
        <Link href={`/dashboard/sales/leads/${a.lead.id}`} className="hover:text-oo-action-primary">
          {a.lead.companyName}
        </Link>
      );
    }
    return <span className="text-oo-text-muted">—</span>;
  }

  /** The due cell: a red chip when it is late, otherwise the moment itself. */
  function due(a: Activity) {
    const late = !a.completedAt && a.dueAt && new Date(a.dueAt) < new Date();
    if (late && a.dueAt) {
      return (
        <span
          data-testid={`late-${a.id}`}
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-oo-status-blocked bg-oo-status-blocked-bg px-2 py-[3px] text-[12px] leading-[18px] text-oo-status-blocked"
        >
          <AlertTriangle size={13} aria-hidden /> {lateBy(a.dueAt, lang)}
        </span>
      );
    }
    if (a.completedAt) {
      return (
        <span className="text-oo-text-muted">
          {ar ? "اكتمل" : "done"} {formatWhen(a.completedAt, lang)}
        </span>
      );
    }
    return a.dueAt ? formatWhen(a.dueAt, lang) : <span className="text-oo-text-muted">—</span>;
  }

  function Complete({ a, full }: { a: Activity; full?: boolean }) {
    if (a.completedAt) {
      return (
        <span className={`${ROW_ACTION} ${full ? "w-full justify-center " : ""}text-oo-text-muted`}>
          {ar ? "مكتمل" : "Completed"}
        </span>
      );
    }
    return (
      <button
        disabled={busy}
        onClick={() => complete(a.id)}
        data-testid={`complete-${a.id}`}
        className={`${full ? "w-full justify-center " : ""}inline-flex items-center whitespace-nowrap rounded-[10px] bg-oo-action-primary px-3 py-[7px] text-[12px] leading-[18px] text-white transition-colors hover:bg-oo-action-primary-hover disabled:opacity-50`}
      >
        {ar ? "إكمال" : "Complete"}
      </button>
    );
  }

  const caption = [
    `${num(counts.open, lang)} ${ar ? "مفتوحة" : "open"}`,
    `${num(counts.overdue, lang)} ${ar ? "متأخّرة" : "overdue"}`,
    `${num(counts.dueToday, lang)} ${ar ? "اليوم" : "due today"}`,
    `${ar ? "النطاق:" : "scope:"} ${
      scope === "own" ? (ar ? "أنشطتي" : "mine") : (ar ? "الفريق" : "the team")
    }`,
  ];
  const captionTestIds = ["count-open", "count-overdue", "count-today", "count-scope"];

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "الأنشطة والمتابعات" : "Activities & Follow-ups"}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            {caption.map((part, i) => (
              <span key={i} className="flex items-center gap-2" data-testid={captionTestIds[i]}>
                {i > 0 && <span aria-hidden className="text-oo-border-strong">·</span>}
                <span>{part}</span>
              </span>
            ))}
          </span>
        }
        actions={
          canSeeTeam ? (
            <Button
              variant={teamView ? "primary" : "secondary"}
              onClick={() => setTeamView(!teamView)}
              testId="toggle-team"
            >
              {teamView ? (ar ? "الفريق" : "Team") : (ar ? "أنشطتي" : "Mine")}
            </Button>
          ) : null
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      <Toolbar>
        <div className="flex flex-1 flex-wrap gap-1.5" role="group" aria-label={ar ? "تصفية" : "Filter"}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              data-testid={`filter-${f.key}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-[10px] border px-[14px] py-2.5 text-[14px] leading-[22px] transition-colors ${
                filter === f.key
                  ? "border-oo-action-primary bg-oo-action-primary font-medium text-white"
                  : "border-oo-border-strong bg-oo-bg-default text-oo-text-primary hover:border-oo-action-primary"
              }`}
            >
              {ar ? f.ar : f.en}
            </button>
          ))}
        </div>
        <FilterSelect value={type} onChange={setType} label={ar ? "النوع" : "Type"} width="w-[170px]">
          <option value="">{ar ? "كل الأنواع" : "All types"}</option>
          {Object.keys(TYPE_LABELS).map((k) => (
            <option key={k} value={k}>{pick(TYPE_LABELS, k, lang)}</option>
          ))}
        </FilterSelect>
      </Toolbar>

      {rows.length === 0 ? (
        <Card>
          <EmptyState>
            <Phone size={28} className="mx-auto mb-2 opacity-40" aria-hidden />
            {filter === "overdue"
              ? ar ? "لا شيء متأخر. جيد." : "Nothing overdue. Good."
              : ar ? "لا يوجد شيء هنا." : "Nothing here."}
          </EmptyState>
        </Card>
      ) : (
        <>
          {/* ── Desktop: the design's six columns, right to left ────────────────────── */}
          <div className="hidden lg:block" data-testid="activity-list">
            <DataTable
              testId="activities-table"
              minWidth={1120}
              cols={[
                { label: ar ? "النشاط" : "Activity", w: "min-w-[260px]" },
                { label: ar ? "النوع" : "Type", w: "w-[150px]" },
                { label: ar ? "مرتبط بـ" : "Linked to", w: "w-[230px]" },
                { label: ar ? "الاستحقاق" : "Due", w: "w-[190px]" },
                { label: ar ? "المالك" : "Owner", w: "w-[140px]" },
                { label: <span className="sr-only">{ar ? "الإجراء" : "Action"}</span>, w: "w-[150px]" },
              ]}
            >
              {rows.map((a) => (
                <Tr key={a.id} testId={`activity-row-${a.id}`}>
                  <Td>
                    <span className="block">{a.subject}</span>
                    {a.body && (
                      <span className="block text-[12px] leading-[18px] text-oo-text-muted">{a.body}</span>
                    )}
                  </Td>
                  <Td>{pick(TYPE_LABELS, a.type, lang)}</Td>
                  <Td>{linkedTo(a)}</Td>
                  <Td>{due(a)}</Td>
                  <Td>{a.owner?.name ?? (ar ? "غير مُسنَد" : "Unassigned")}</Td>
                  <Td><Complete a={a} /></Td>
                </Tr>
              ))}
            </DataTable>
          </div>

          {/* ── Narrow: the same six facts stacked ──────────────────────────────────── */}
          <ul className="space-y-2 lg:hidden">
            {rows.map((a) => (
              <li
                key={a.id}
                data-testid={`m-activity-${a.id}`}
                className="rounded-2xl border border-oo-border-default bg-oo-bg-default p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="shrink-0 text-[12px] leading-[18px] text-oo-text-muted">
                    {pick(TYPE_LABELS, a.type, lang)}
                  </span>
                  <div className="min-w-0 text-end">
                    <span className="block text-[14px] leading-[22px] text-oo-text-primary">{a.subject}</span>
                    <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                      {linkedTo(a)}
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <Complete a={a} />
                  <span className="text-[12px] leading-[18px]">{due(a)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-[12px] leading-[18px] text-oo-text-muted">
        {ar
          ? "إكمال متابعة يسجّل أنها حدثت. لا يُرسل النظام بريداً ولا رسائل."
          : "Completing a follow-up records that it happened. Nothing here sends an email or a message."}
      </p>
    </div>
  );
}
