"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, AlertCircle, Phone } from "lucide-react";
import {
  useLang, pick, ProvisionalBanner, PageHeader, Alert, Card, EmptyState, Spinner,
  Button, Field, Select, Pill, api,
} from "../_components/ui";
import { formatDate } from "@/lib/utils";

/**
 * Follow-ups — the screen a salesperson opens first in the morning.
 *
 * Organised around what is late rather than around what exists. An activity list sorted by
 * creation date is a log; this is a work queue, so the counts and the default filter both
 * lead with overdue.
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
  CALL: { en: "Call", ar: "اتصال" },
  VISIT: { en: "Visit", ar: "زيارة" },
  MEETING: { en: "Meeting", ar: "اجتماع" },
  NOTE: { en: "Note", ar: "ملاحظة" },
  TASK: { en: "Task", ar: "مهمة" },
  SAMPLE_FOLLOW_UP: { en: "Sample follow-up", ar: "متابعة عينة" },
};

const FILTERS = [
  { key: "overdue", en: "Overdue", ar: "متأخرة" },
  { key: "today", en: "Due today", ar: "اليوم" },
  { key: "open", en: "All open", ar: "المفتوحة" },
  { key: "done", en: "Completed", ar: "المكتملة" },
] as const;

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

  const load = useCallback(async () => {
    const params = new URLSearchParams({ filter });
    if (type) params.set("type", type);
    if (!teamView) params.set("scope", "mine");
    const res = await api<{
      rows: Activity[];
      counts: { overdue: number; dueToday: number; open: number };
      scope: "own" | "all";
      canSeeTeam: boolean;
    }>(`/api/sales/activities?${params}`);
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
  }, [filter, type, teamView, ar]);

  useEffect(() => {
    load();
  }, [load]);

  async function complete(id: string) {
    if (busy) return;
    setBusy(true);
    const res = await api(`/api/sales/activities/${id}`, { method: "PATCH", body: { completed: true } });
    setBusy(false);
    if (res.ok) load();
    else setError(res.data.error ?? "");
  }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "المتابعات والمهام" : "Follow-ups & tasks"}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap mt-1">
            {counts.overdue > 0 && (
              <Pill tone="bad" testId="count-overdue">
                {counts.overdue} {ar ? "متأخرة" : "overdue"}
              </Pill>
            )}
            {counts.dueToday > 0 && (
              <Pill tone="warn" testId="count-today">
                {counts.dueToday} {ar ? "اليوم" : "today"}
              </Pill>
            )}
            <Pill tone="info" testId="count-open">
              {counts.open} {ar ? "مفتوحة" : "open"}
            </Pill>
            {scope === "own" && (
              <span className="text-[11px] text-brown/60 font-semibold">
                {ar ? "متابعاتك فقط" : "your own follow-ups only"}
              </span>
            )}
          </span>
        }
        actions={
          canSeeTeam ? (
            <Button
              variant={teamView ? "primary" : "secondary"}
              onClick={() => setTeamView(!teamView)}
              testId="toggle-team"
            >
              {teamView ? (ar ? "الفريق" : "Team") : (ar ? "أنا" : "Mine")}
            </Button>
          ) : null
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}

      <div className="flex gap-2 flex-wrap items-end">
        <div
          className="flex gap-1.5 flex-wrap"
          role="group"
          aria-label={ar ? "تصفية" : "Filter"}
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              data-testid={`filter-${f.key}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 rounded-xl text-xs font-bold border-2 transition-colors ${
                filter === f.key
                  ? "bg-orange text-white border-orange"
                  : "bg-white border-border text-brown hover:border-orange"
              }`}
            >
              {ar ? f.ar : f.en}
            </button>
          ))}
        </div>
        <div className="w-44">
          <Field id="act-type-filter" label={ar ? "النوع" : "Type"}>
            <Select id="act-type-filter" value={type} onChange={setType}>
              <option value="">{ar ? "الكل" : "All"}</option>
              {Object.keys(TYPE_LABELS).map((k) => (
                <option key={k} value={k}>{pick(TYPE_LABELS, k, lang)}</option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

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
        <ul className="space-y-2" data-testid="activity-list">
          {rows.map((a) => {
            const late = !a.completedAt && a.dueAt && new Date(a.dueAt) < new Date();
            const subject = a.opportunity ?? a.lead;
            return (
              <li
                key={a.id}
                data-testid={`activity-row-${a.id}`}
                className={`bg-white rounded-2xl border p-4 flex items-start gap-3 ${
                  late ? "border-red-200" : "border-border"
                }`}
              >
                <span className="mt-0.5 flex-shrink-0">
                  {a.completedAt ? (
                    <CheckCircle2 size={17} className="text-emerald-600" aria-hidden />
                  ) : late ? (
                    <AlertCircle size={17} className="text-red-600" aria-hidden />
                  ) : (
                    <Clock size={17} className="text-brown/50" aria-hidden />
                  )}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Pill>{pick(TYPE_LABELS, a.type, lang)}</Pill>
                    <span className="font-bold text-sm text-charcoal break-words">{a.subject}</span>
                    {late && <Pill tone="bad">{ar ? "متأخرة" : "Overdue"}</Pill>}
                  </div>

                  {a.body && <p className="text-xs text-brown mt-1 break-words">{a.body}</p>}

                  <p className="text-[11px] text-brown/60 mt-1.5 flex items-center gap-1.5 flex-wrap">
                    {a.opportunity ? (
                      <Link
                        href={`/dashboard/sales/deals/${a.opportunity.id}`}
                        className="font-bold text-orange hover:underline"
                      >
                        {a.opportunity.title}
                      </Link>
                    ) : a.lead ? (
                      <Link href="/dashboard/sales/leads" className="font-bold text-orange hover:underline">
                        {a.lead.companyName}
                      </Link>
                    ) : null}
                    {subject && <span>·</span>}
                    <span>{a.owner?.name}</span>
                    {a.dueAt && (
                      <>
                        <span>·</span>
                        <span className={late ? "text-red-600 font-bold" : ""}>
                          {ar ? "الاستحقاق" : "due"} {formatDate(a.dueAt)}
                        </span>
                      </>
                    )}
                    {a.completedAt && (
                      <>
                        <span>·</span>
                        <span>{ar ? "اكتمل" : "done"} {formatDate(a.completedAt)}</span>
                      </>
                    )}
                  </p>
                </div>

                {!a.completedAt && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => complete(a.id)}
                    testId={`complete-${a.id}`}
                  >
                    {ar ? "تم" : "Done"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "إكمال متابعة يسجّل أنها حدثت. لا يُرسل النظام بريداً ولا رسائل."
          : "Completing a follow-up records that it happened. Nothing here sends an email or a message."}
      </p>
    </div>
  );
}
