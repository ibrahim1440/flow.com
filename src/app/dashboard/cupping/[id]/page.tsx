"use client";

import { useState, useEffect, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft, ChevronRight, FlaskConical, CheckCircle, Clock, Lock, LockOpen, Users,
} from "lucide-react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from "recharts";
import CuppingForm, { type CuppingFormData } from "@/app/dashboard/cupping/CuppingForm";
import { useUser } from "@/app/dashboard/layout";

type Score = {
  id: string;
  sessionId: string;
  sessionBatchId: string | null;
  employeeId: string | null;
  externalName: string | null;
  employee: { id: string; name: string } | null;
  fragranceAroma: number; flavor: number; aftertaste: number;
  acidity: number; body: number; balance: number; overall: number;
  uniformity: number; cleanCup: number; sweetness: number;
  defectCups: number; defectType: string;
  finalScore: number;
  notes: string | null;
  flavorDescriptors: string[];
};

type SessionBatch = {
  id: string;
  order: number;
  isExternalSample: boolean;
  externalSampleName: string | null;
  externalSupplierName: string | null;
  batch: {
    batchNumber: string;
    roastProfile: string | null;
    greenBean: { beanType: string; serialNumber: string } | null;
    orderItem: { beanTypeName: string } | null;
  } | null;
};

type Session = {
  id: string;
  name: string;
  date: string;
  status: "Open" | "Closed";
  blind: boolean;
  batch: { batchNumber: string } | null;
  greenBean: { serialNumber: string; beanType: string } | null;
  sessionBatches: SessionBatch[];
  scores: Score[];
};

const RADAR_ATTRS = [
  { key: "fragranceAroma", label: "Fragrance" },
  { key: "flavor",         label: "Flavor" },
  { key: "aftertaste",     label: "Aftertaste" },
  { key: "acidity",        label: "Acidity" },
  { key: "body",           label: "Body" },
  { key: "balance",        label: "Balance" },
  { key: "overall",        label: "Overall" },
] as const;

function avg(scores: Score[], key: keyof Score): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, s) => sum + (s[key] as number), 0) / scores.length;
}

function ScoreTable({ scores }: { scores: Score[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 pr-4 text-xs font-bold text-brown/50 uppercase tracking-wide">Cupper</th>
            <th className="text-right py-2 px-2 text-xs font-bold text-brown/50 uppercase tracking-wide">Score</th>
            <th className="text-right py-2 pl-2 text-xs font-bold text-brown/50 uppercase tracking-wide hidden sm:table-cell">Descriptors</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s) => (
            <tr key={s.id} className="border-b border-border/50 hover:bg-cream/50 transition-colors">
              <td className="py-3 pr-4 font-medium text-charcoal">
                {s.employee?.name ?? s.externalName ?? "External"}
              </td>
              <td className="py-3 px-2 text-right">
                <span className="font-extrabold tabular-nums text-charcoal">{s.finalScore.toFixed(2)}</span>
              </td>
              <td className="py-3 pl-2 text-right hidden sm:table-cell">
                <span className="text-xs text-brown/50">
                  {s.flavorDescriptors.slice(0, 3).join(", ")}
                  {s.flavorDescriptors.length > 3 && ` +${s.flavorDescriptors.length - 3}`}
                </span>
              </td>
            </tr>
          ))}
          {scores.length > 1 && (
            <tr className="bg-orange/5">
              <td className="py-3 pr-4 font-extrabold text-orange text-xs uppercase tracking-wide">Average</td>
              <td className="py-3 px-2 text-right font-extrabold text-orange text-lg tabular-nums">
                {(scores.reduce((a, s) => a + s.finalScore, 0) / scores.length).toFixed(2)}
              </td>
              <td className="hidden sm:table-cell" />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CupIdentityBadge({ sb }: { sb: SessionBatch }) {
  if (sb.isExternalSample) {
    return (
      <div className="space-y-0.5">
        <p className="text-sm font-extrabold text-charcoal">{sb.externalSampleName ?? "External Sample"}</p>
        {sb.externalSupplierName && (
          <p className="text-xs text-brown/60">{sb.externalSupplierName} · <span className="text-amber-600 font-bold">عينة مورد</span></p>
        )}
        {!sb.externalSupplierName && (
          <p className="text-xs text-amber-600 font-bold">عينة مورد</p>
        )}
      </div>
    );
  }
  const beanType = sb.batch?.greenBean?.beanType ?? sb.batch?.orderItem?.beanTypeName ?? "Unknown";
  const batchNumber = sb.batch?.batchNumber ?? "—";
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-extrabold text-charcoal">{beanType}</p>
      <p className="text-xs text-brown/60">Batch {batchNumber}</p>
    </div>
  );
}

function AggregateResults({ scores }: { scores: Score[] }) {
  const allDescriptors = scores.flatMap((s) => s.flavorDescriptors);
  const descriptorCount = allDescriptors.reduce<Record<string, number>>((acc, d) => {
    acc[d] = (acc[d] ?? 0) + 1;
    return acc;
  }, {});
  const topDescriptors = Object.entries(descriptorCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const radarData = RADAR_ATTRS.map((a) => ({
    attribute: a.label,
    average: parseFloat(avg(scores, a.key).toFixed(2)),
  }));

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-2xl border border-border p-5">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide mb-4">
          Average Sensory Profile
        </h3>
        <ResponsiveContainer width="100%" height={280}>
          <RadarChart data={radarData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
            <PolarGrid stroke="#e5e7eb" />
            <PolarAngleAxis dataKey="attribute" tick={{ fontSize: 11, fill: "#6b4c2a", fontWeight: 600 }} />
            <PolarRadiusAxis angle={90} domain={[6, 10]} tickCount={5} tick={{ fontSize: 9, fill: "#9ca3af" }} />
            <Radar name="Average" dataKey="average" stroke="#E25D2F" fill="#E25D2F" fillOpacity={0.25} strokeWidth={2} />
            <Tooltip
              formatter={(v) => [typeof v === "number" ? v.toFixed(2) : v, "Avg Score"]}
              contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb", fontSize: 12 }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </section>

      <section className="bg-white rounded-2xl border border-border p-5">
        <div className="flex items-center gap-2 mb-4">
          <Users size={16} className="text-orange" />
          <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide">
            Individual Scores ({scores.length})
          </h3>
        </div>
        <ScoreTable scores={scores} />
      </section>

      {topDescriptors.length > 0 && (
        <section className="bg-white rounded-2xl border border-border p-5">
          <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide mb-3">
            Panel Flavor Descriptors
          </h3>
          <div className="flex flex-wrap gap-2">
            {topDescriptors.map(([tag, count]) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-orange/10 text-orange border border-orange/20"
              >
                {tag}
                {count > 1 && (
                  <span className="bg-orange text-white text-[10px] font-extrabold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {count}
                  </span>
                )}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="bg-white rounded-2xl border border-border p-5">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide mb-4">
          Attribute Averages
        </h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {RADAR_ATTRS.map((a) => {
            const val = avg(scores, a.key);
            const pct = ((val - 6) / 4) * 100;
            return (
              <div key={a.key} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-brown/70 font-medium">{a.label}</span>
                  <span className="font-extrabold text-charcoal tabular-nums">{val.toFixed(2)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100">
                  <div className="h-1.5 rounded-full bg-orange" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          {(["uniformity", "cleanCup", "sweetness"] as const).map((k) => {
            const label = k === "cleanCup" ? "Clean Cup" : k.charAt(0).toUpperCase() + k.slice(1);
            const val = avg(scores, k);
            const pct = (val / 10) * 100;
            return (
              <div key={k} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-brown/70 font-medium">{label}</span>
                  <span className="font-extrabold text-charcoal tabular-nums">{val.toFixed(2)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100">
                  <div className="h-1.5 rounded-full bg-orange" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ResultsView({ session }: { session: Session }) {
  const scores = session.scores;
  const isMultiCup = session.sessionBatches.length > 0;

  if (!isMultiCup) {
    return <AggregateResults scores={scores} />;
  }

  // Multi-cup blind session — show per-cup reveal then aggregate
  return (
    <div className="space-y-6">
      {/* Per-cup unblinded breakdown */}
      <section className="space-y-3">
        <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide px-1">
          Cup Reveal — كشف الهوية
        </h3>
        {session.sessionBatches.map((sb, i) => {
          const cupScores = scores.filter((s) => s.sessionBatchId === sb.id);
          const cupAvg = cupScores.length > 0
            ? cupScores.reduce((a, s) => a + s.finalScore, 0) / cupScores.length
            : null;
          return (
            <div key={sb.id} className="bg-white rounded-2xl border border-border overflow-hidden">
              {/* Cup header */}
              <div className="flex items-center gap-4 px-5 py-4 border-b border-border bg-cream/50">
                <div className="w-10 h-10 rounded-xl bg-orange/10 flex items-center justify-center shrink-0 font-extrabold text-lg text-orange">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-brown/40 uppercase tracking-widest mb-0.5">
                    Cup {i + 1} · كوب {i + 1}
                  </p>
                  <CupIdentityBadge sb={sb} />
                </div>
                {cupAvg !== null && (
                  <div className="text-right shrink-0">
                    <p className="text-[10px] text-brown/40 font-bold uppercase tracking-wide">Avg</p>
                    <p className="text-2xl font-black text-orange tabular-nums">{cupAvg.toFixed(2)}</p>
                  </div>
                )}
                {cupAvg === null && (
                  <p className="text-xs text-brown/30 font-medium shrink-0">No scores</p>
                )}
              </div>
              {/* Cup scores */}
              {cupScores.length > 0 && (
                <div className="px-5 py-3">
                  <ScoreTable scores={cupScores} />
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* Overall aggregate view */}
      {scores.length > 0 && (
        <div>
          <h3 className="text-sm font-extrabold text-charcoal uppercase tracking-wide px-1 mb-3">
            Overall Panel Summary
          </h3>
          <AggregateResults scores={scores} />
        </div>
      )}
    </div>
  );
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const user = useUser();

  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // null = cup-picker list; a sessionBatch id = scoring that cup
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  const fetchSession = useCallback(async () => {
    const res = await fetch(`/api/cupping/sessions/${id}`);
    if (res.ok) setSession(await res.json());
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchSession(); }, [fetchSession]);

  async function handleSubmit(data: CuppingFormData) {
    setSubmitting(true);
    setSubmitError("");
    const body = activeBatchId ? { ...data, sessionBatchId: activeBatchId } : data;
    const res = await fetch(`/api/cupping/sessions/${id}/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json();
      setSubmitError(j.error || "Failed to submit score");
      setSubmitting(false);
      return;
    }
    setActiveBatchId(null);
    await fetchSession();
    setSubmitting(false);
  }

  if (loading) {
    return (
      <div className="max-w-xl mx-auto pt-16 text-center text-brown/40 text-sm">
        Loading session…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="max-w-xl mx-auto pt-16 text-center">
        <p className="font-bold text-charcoal">Session not found</p>
        <button onClick={() => router.push("/dashboard/cupping")} className="mt-4 text-orange text-sm font-bold">
          ← Back to Cupping
        </button>
      </div>
    );
  }

  const isClosed = session.status === "Closed";
  const isMultiCup = session.sessionBatches.length > 0;
  // scores in blind (Open) mode are already filtered to the current user's own
  const myScores = session.scores.filter((s) => s.employeeId === user?.id);
  const scoredBatchIds = new Set(myScores.map((s) => s.sessionBatchId).filter(Boolean) as string[]);
  const hasAllScored = isMultiCup
    ? session.sessionBatches.every((sb) => scoredBatchIds.has(sb.id))
    : myScores.length > 0;

  // The cup currently being scored (for label in the form header)
  const activeCupIndex = session.sessionBatches.findIndex((sb) => sb.id === activeBatchId);

  const sessionHeader = (
    <div>
      <button
        onClick={() => {
          if (activeBatchId) { setActiveBatchId(null); return; }
          router.push("/dashboard/cupping");
        }}
        className="flex items-center gap-1.5 text-sm font-bold text-brown/60 hover:text-charcoal transition-colors mb-3"
      >
        <ChevronLeft size={16} />
        {activeBatchId ? "All Cups" : "All Sessions"}
      </button>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal flex items-center gap-3">
            <FlaskConical className="text-orange shrink-0" size={26} />
            {session.name}
          </h1>
          <div className="flex items-center gap-3 mt-1 text-xs text-brown/50 flex-wrap">
            <span>{new Date(session.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
            {session.batch && <span>Batch: {session.batch.batchNumber}</span>}
            {session.greenBean && <span>{session.greenBean.beanType} #{session.greenBean.serialNumber}</span>}
            {isMultiCup && activeBatchId && (
              <span className="font-bold text-orange">
                Cup {activeCupIndex + 1} of {session.sessionBatches.length}
              </span>
            )}
          </div>
        </div>
        <span className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
          isClosed ? "bg-gray-100 text-gray-500" : "bg-green-100 text-green-700"
        }`}>
          {isClosed ? <Lock size={10} /> : <LockOpen size={10} />}
          {session.status}
        </span>
      </div>
    </div>
  );

  // ── Closed session ────────────────────────────────────────────────────────
  if (isClosed) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        {sessionHeader}
        {session.scores.length === 0 ? (
          <div className="bg-white rounded-2xl border border-border p-8 text-center">
            <p className="text-brown/50 text-sm">No scores were submitted for this session.</p>
          </div>
        ) : (
          <ResultsView session={session} />
        )}
      </div>
    );
  }

  // ── Open, single-cup: all scored ─────────────────────────────────────────
  if (!isMultiCup && hasAllScored) {
    const myScore = myScores[0]!;
    return (
      <div className="max-w-xl mx-auto space-y-6">
        {sessionHeader}
        <div className="bg-white rounded-2xl border border-green-200 p-8 text-center space-y-3">
          <CheckCircle size={40} className="text-green-500 mx-auto" />
          <p className="text-xl font-extrabold text-charcoal">Score Submitted</p>
          <p className="text-5xl font-black text-green-600">{myScore.finalScore.toFixed(2)}</p>
          {myScore.flavorDescriptors.length > 0 && (
            <p className="text-sm text-brown/60">
              Descriptors: <strong className="text-charcoal">{myScore.flavorDescriptors.join(", ")}</strong>
            </p>
          )}
          <div className="flex items-center justify-center gap-2 pt-2 text-sm text-brown/50">
            <Clock size={14} />
            <span>Waiting for the session to be closed and scores revealed</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Open, single-cup: not yet scored ─────────────────────────────────────
  if (!isMultiCup) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        {sessionHeader}
        <div className="space-y-4">
          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 font-medium">
              {submitError}
            </div>
          )}
          <CuppingForm onSubmit={handleSubmit} submitting={submitting} submitLabel="Submit My Score" />
        </div>
      </div>
    );
  }

  // ── Open, multi-cup: all cups scored ─────────────────────────────────────
  if (hasAllScored) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        {sessionHeader}
        <div className="bg-white rounded-2xl border border-green-200 p-6 space-y-4">
          <div className="text-center space-y-2">
            <CheckCircle size={40} className="text-green-500 mx-auto" />
            <p className="text-xl font-extrabold text-charcoal">All Cups Scored!</p>
            <p className="text-sm text-brown/50">Waiting for the session to be closed and scores revealed.</p>
          </div>
          <div className="space-y-2 pt-2">
            {session.sessionBatches.map((sb, i) => {
              const cupScore = myScores.find((s) => s.sessionBatchId === sb.id);
              return (
                <div key={sb.id} className="flex items-center gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-xl">
                  <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                    <CheckCircle size={16} className="text-green-600" />
                  </div>
                  <p className="flex-1 text-sm font-bold text-green-800">Cup {i + 1} — كوب {i + 1}</p>
                  {cupScore && (
                    <span className="text-lg font-black text-green-700 tabular-nums">{cupScore.finalScore.toFixed(2)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Open, multi-cup: scoring a specific cup ───────────────────────────────
  if (activeBatchId) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        {sessionHeader}
        {submitError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 font-medium">
            {submitError}
          </div>
        )}
        <CuppingForm
          onSubmit={handleSubmit}
          submitting={submitting}
          submitLabel={`Submit Cup ${activeCupIndex + 1} Score →`}
        />
      </div>
    );
  }

  // ── Open, multi-cup: cup picker ───────────────────────────────────────────
  const remaining = session.sessionBatches.filter((sb) => !scoredBatchIds.has(sb.id));
  return (
    <div className="max-w-xl mx-auto space-y-6">
      {sessionHeader}
      <div className="space-y-2">
        <p className="text-sm font-bold text-charcoal">
          {scoredBatchIds.size > 0
            ? `${remaining.length} cup${remaining.length !== 1 ? "s" : ""} remaining — أكواب متبقية`
            : "Select a cup to begin scoring — اختر كوبًا للبدء"}
        </p>
        {session.sessionBatches.map((sb, i) => {
          const done = scoredBatchIds.has(sb.id);
          const cupScore = myScores.find((s) => s.sessionBatchId === sb.id);
          return (
            <button
              key={sb.id}
              onClick={() => !done && setActiveBatchId(sb.id)}
              disabled={done}
              className={`w-full flex items-center gap-4 p-4 rounded-2xl border-2 transition-all text-left ${
                done
                  ? "border-green-200 bg-green-50 opacity-80 cursor-default"
                  : "border-border bg-white hover:border-orange hover:shadow-md active:scale-[0.99]"
              }`}
            >
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 font-extrabold text-lg ${
                done ? "bg-green-100 text-green-600" : "bg-orange/10 text-orange"
              }`}>
                {done ? <CheckCircle size={22} /> : i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`font-extrabold ${done ? "text-green-700" : "text-charcoal"}`}>
                  كوب {i + 1} — Cup {i + 1}
                </p>
                <p className="text-xs text-brown/50 mt-0.5">
                  {done ? `✓ Scored — ${cupScore?.finalScore.toFixed(2) ?? ""}` : "Tap to score this cup"}
                </p>
              </div>
              {!done && <ChevronRight size={18} className="text-brown/30 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
