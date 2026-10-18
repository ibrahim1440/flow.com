"use client";

import { useState, useEffect, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, ChevronLeft } from "lucide-react";
import CuppingForm, { descriptorLabel, type CuppingFormData } from "@/app/dashboard/cupping/CuppingForm";
import { Btn, CUP_FORMS, GUEST_FORMS, Notice, OpsEmpty, OpsLoading, OpsRoot, PageHeader, SCORE_FORMS, SecHead, StatusDot, countNoun, cupsOf, opsDate, scorersOf, useL } from "@/components/ops/ui";
import { useUser } from "@/app/dashboard/user-context";
import { useI18n } from "@/lib/i18n/context";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { PrintDialog, type DialogItem } from "@/components/print/PrintDialog";
import { PRINT_GATE_NOTE_ID, PrintNotCertifiedNotice, usePrintCertified } from "@/components/print/Certification";

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
  // E6 close policy. Null on a session closed before the policy existed (shown as plain «مغلقة»).
  closeKind: "COMPLETE" | "INCOMPLETE" | null;
  closedAt: string | null;
  closedByName: string | null;
  closeReason: string | null;
  minScorersAtClose: number | null;
  scorersAtClose: number | null;
  // Owner decision 3: each staff scorer's progress (name, cups scored — never a score).
  requiredCups: number;
  scorerProgress: { employeeId: string; name: string | null; cupsScored: number; complete: boolean }[];
};

// The seven SCA sensory attributes, scored 6–10. G-9 option B (labelled bars + table); the
// wording is the GX-G copy of G-07 1224:1722 (N-09), the same as the scoring form.
const SENSORY = [
  { key: "fragranceAroma", ar: "العطر / الرائحة", en: "Fragrance" },
  { key: "flavor",         ar: "الطعم",           en: "Flavor" },
  { key: "aftertaste",     ar: "النكهة الباقية",  en: "Aftertaste" },
  { key: "acidity",        ar: "الحموضة",         en: "Acidity" },
  { key: "body",           ar: "الثقل",           en: "Body" },
  { key: "balance",        ar: "التوازن",         en: "Balance" },
  { key: "overall",        ar: "التقييم العام",   en: "Overall" },
] as const;
// The three cup attributes, 5 cups × 2 = 0–10.
const CUP_ATTRS = [
  { key: "uniformity", ar: "التجانس",     en: "Uniformity" },
  { key: "cleanCup",   ar: "نقاء الكوب",  en: "Clean cup" },
  { key: "sweetness",  ar: "الحلاوة",     en: "Sweetness" },
] as const;

function avg(scores: Score[], key: keyof Score): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, s) => sum + (s[key] as number), 0) / scores.length;
}

const scorerName = (s: Score, external: string) => s.employee?.name ?? s.externalName ?? external;

/** «التقييمات الفردية»: cupper · score · descriptors, with the panel average. */
function ScoreTable({ scores }: { scores: Score[] }) {
  const L = useL();
  const { lang } = useI18n();
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-mrow ops-scoretable" aria-label={L("التقييمات الفردية", "Individual scores")}>
        <thead>
          <tr>
            <th>{L("المقيّم", "Cupper")}</th>
            <th className="num">{L("النتيجة", "Score")}</th>
            <th className="hr-hide-mobile">{L("الواصفات", "Descriptors")}</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s) => (
            <tr key={s.id}>
              <td className="m-title">
                {scorerName(s, L("مقيّم خارجي", "External"))}
                <span className="hr-msub">{s.flavorDescriptors.slice(0, 3).map((d) => descriptorLabel(d, lang)).join(L("، ", ", "))}{s.flavorDescriptors.length > 3 ? ` +${s.flavorDescriptors.length - 3}` : ""}</span>
              </td>
              <td className="num m-end"><span className="hr-num">{s.finalScore.toFixed(2)}</span></td>
              <td className="hr-hide-mobile"><span className="hr-caption">{s.flavorDescriptors.slice(0, 3).map((d) => descriptorLabel(d, lang)).join(L("، ", ", "))}{s.flavorDescriptors.length > 3 ? ` +${s.flavorDescriptors.length - 3}` : ""}</span></td>
            </tr>
          ))}
        </tbody>
        {scores.length > 1 ? (
          <tfoot>
            <tr>
              <td>{L("المتوسط", "Average")}</td>
              <td className="num"><span className="hr-num">{(scores.reduce((a, s) => a + s.finalScore, 0) / scores.length).toFixed(2)}</span></td>
              <td className="hr-hide-mobile" />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function cupName(sb: SessionBatch, L: (ar: string, en: string) => string): string {
  if (sb.isExternalSample) return sb.externalSampleName ?? L("عينة خارجية", "External sample");
  return sb.batch?.greenBean?.beanType ?? sb.batch?.orderItem?.beanTypeName ?? L("غير معروف", "Unknown");
}

/** G-07 «كشف الأكواب»: one card per cup — its average, what it was, and each scorer's score. */
function CupCards({ session, scores }: { session: Session; scores: Score[] }) {
  const L = useL();
  return (
    <section className="hr-stack" style={{ gap: 10 }}>
      <SecHead title={L("كشف الأكواب", "Cup reveal")} caption={L("المتوسط من 100 · لكل مقيّم", "Average out of 100 · per scorer")} />
      <div className="ops-cups">
        {session.sessionBatches.map((sb, i) => {
          const cs = scores.filter((s) => s.sessionBatchId === sb.id);
          const a = cs.length > 0 ? cs.reduce((x, s) => x + s.finalScore, 0) / cs.length : null;
          return (
            <div key={sb.id} className="ops-cup" data-testid={`cup-card-${i + 1}`}>
              <div className="ops-cup-head">
                <span className="hr-caption">{L("كوب", "Cup")} <span className="hr-num">{i + 1}</span></span>
                {a !== null ? <span className="ops-cup-score hr-num">{a.toFixed(2)}</span> : <span className="ops-cup-score hr-muted" style={{ fontSize: 13 }}>{L("لا تقييمات", "No scores")}</span>}
              </div>
              <div>
                <div className="ops-cup-name">{cupName(sb, L)}</div>
                <div className="hr-caption" style={{ margin: "2px 0 0" }}>
                  {sb.isExternalSample
                    ? <>{sb.externalSupplierName ? <>{sb.externalSupplierName} · </> : null}{L("عينة مورد", "Supplier sample")}</>
                    : <span className="ops-serial">{sb.batch?.batchNumber ?? "—"}</span>}
                </div>
              </div>
              {cs.length > 0 ? (
                <ul className="ops-cup-scorers">
                  {cs.map((s) => <li key={s.id}><span>{scorerName(s, L("مقيّم خارجي", "External"))}</span><span className="hr-num">{s.finalScore.toFixed(2)}</span></li>)}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Labelled bars, values written (G-9 option B). `min`–`max` is the attribute's scale. */
function Bars({ rows, min, max, label }: { rows: { key: string; label: string; v: number }[]; min: number; max: number; label: string }) {
  return (
    <ul className="ops-scorebars" aria-label={label}>
      {rows.map((r) => {
        const pct = Math.max(0, Math.min(100, ((r.v - min) / (max - min)) * 100));
        return (
          <li key={r.key}>
            <span className="ops-scorebar-label">{r.label}</span>
            <span className="ops-scorebar-track" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
            <span className="ops-scorebar-val hr-num">{r.v.toFixed(2)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** G-07 (option B): sensory bars + individual scores | descriptors, the QC note, cup averages. */
function AggregateResults({ scores }: { scores: Score[] }) {
  const L = useL();
  const { lang } = useI18n();
  const counts = scores.flatMap((s) => s.flavorDescriptors).reduce<Record<string, number>>((acc, d) => { acc[d] = (acc[d] ?? 0) + 1; return acc; }, {});
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  return (
    <div className="ops-results-cols">
      <div>
        <section className="hr-stack" style={{ gap: 8 }}>
          <SecHead title={L("متوسط الصفات الحسية", "Average sensory profile")} caption={L("كل الأكواب · مقياس 6–10", "All cups · 6–10 scale")} />
          <Bars label={L("متوسط الصفات الحسية", "Average sensory profile")} min={6} max={10}
            rows={SENSORY.map((a) => ({ key: a.key, label: lang === "ar" ? a.ar : a.en, v: avg(scores, a.key) }))} />
        </section>
        <section className="hr-stack" style={{ gap: 8 }}>
          <SecHead title={<>{L("التقييمات الفردية", "Individual scores")} <span className="hr-num">({scores.length})</span></>} caption={L("كل الأكواب", "All cups")} />
          <ScoreTable scores={scores} />
        </section>
      </div>
      <div>
        <section className="hr-stack" style={{ gap: 12 }}>
          <SecHead title={L("واصفات اللوحة", "Panel descriptors")} />
          {top.length > 0 ? (
            <div className="ops-chips">
              {top.map(([tag, n]) => <span key={tag} className="ops-chip">{descriptorLabel(tag, lang)} <b className="hr-num">{n}</b></span>)}
            </div>
          ) : <p className="hr-caption" style={{ margin: 0 }}>{L("لا واصفات مسجّلة.", "No descriptors recorded.")}</p>}
          <div className="ops-note" style={{ padding: "12px 14px", borderRadius: 10, background: "var(--surface-subtle)", fontSize: 13.5, lineHeight: "22px", color: "var(--text-secondary)" }}>
            <b style={{ fontWeight: 600, color: "var(--text-primary)" }}>{L("التذوق لا يقرر قبول الدفعة.", "Cupping does not accept a batch.")}</b>{" "}
            {L("نتيجة الجلسة للمقارنة والتقييم الحسي فقط. قبول الدفعة أو رفضها قرار الجودة في «قائمة الفحص».", "A session result is sensory evaluation only. Accepting or rejecting a batch is the QC decision in «QC queue».")}
          </div>
        </section>
        <section className="hr-stack" style={{ gap: 8 }}>
          <SecHead title={L("متوسط الأكواب", "Cup averages")} caption={L("من 10 · 5 أكواب × نقطتان", "Out of 10 · 5 cups × 2 points")} />
          <Bars label={L("متوسط الأكواب", "Cup averages")} min={0} max={10}
            rows={CUP_ATTRS.map((a) => ({ key: a.key, label: lang === "ar" ? a.ar : a.en, v: avg(scores, a.key) }))} />
        </section>
      </div>
    </div>
  );
}

/**
 * E6 / C-2: a session an administrator closed below the minimum keeps all its scores, but its
 * results are not final. This is the one place that shows them, and it labels them so.
 */
function IncompleteNotice({ session }: { session: Session }) {
  const L = useL();
  const { lang } = useI18n();
  if (session.closeKind !== "INCOMPLETE") return null;
  return (
    <Notice tone="warning">
      <span data-testid="cupping-incomplete-notice">
        <strong style={{ fontWeight: 600 }}>{L("جلسة غير مكتملة · نتائج غير نهائية", "Incomplete session · results not final")}</strong>
        {session.minScorersAtClose !== null && session.scorersAtClose !== null
          ? <> · {L("أُغلقت عند", "Closed at")} <span>{scorersOf(session.scorersAtClose, session.minScorersAtClose, lang)}</span></>
          : null}
      </span>
      {session.closeReason ? <div>{L("السبب", "Reason")}: {session.closeReason}</div> : null}
      <div className="hr-caption">
        {session.closedByName ? <>{L("أغلقها", "Closed by")} {session.closedByName}</> : null}
        {session.closedAt ? <> · {opsDate(session.closedAt, lang)}</> : null}
        {" · "}{L("لا تدخل في النتائج النهائية.", "Left out of final results.")}
      </div>
    </Notice>
  );
}

/**
 * Owner decision 3: a staff scorer counts toward the close minimum only once every required
 * cup is scored. Each scorer's progress is listed — names and cup counts, never a score, so
 * an open session stays blind.
 */
function ScorerStatus({ session }: { session: Session }) {
  const L = useL();
  const { lang } = useI18n();
  const rows = session.scorerProgress ?? [];
  return (
    <section className="hr-stack" style={{ gap: 8 }} data-testid="cupping-scorer-status">
      <SecHead title={L("حالة المقيّمين", "Scorer status")} caption={L("يُحتسب المقيّم بعد تقييم كل الأكواب", "A scorer counts once every cup is scored")} />
      {rows.length === 0 ? (
        <p className="hr-caption" style={{ margin: 0 }}>{L("لم يقيّم أحد من الموظفين بعد.", "No staff member has scored yet.")}</p>
      ) : (
        <ul className="ops-list">
          {rows.map((r) => (
            <li key={r.employeeId} data-testid={`cupping-scorer-${r.employeeId}`}>
              <span>{r.name ?? L("موظف", "Staff")}</span>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "baseline" }}>
                <span>{cupsOf(r.cupsScored, session.requiredCups, lang)}</span>
                <span className={`hr-dot tone-${r.complete ? "success" : "warning"}`}><span>{r.complete ? L("مكتمل", "Complete") : L("غير مكتمل · لا يُحتسب", "Incomplete · not counted")}</span></span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Owner decision 4: guest evaluations are supplementary. They are kept and shown here, apart
 * from the panel, and never enter the official averages above.
 */
function GuestFeedback({ session, guests }: { session: Session; guests: Score[] }) {
  const L = useL();
  const { lang } = useI18n();
  if (guests.length === 0) return null;
  const cupNo = (id: string | null) => {
    const i = session.sessionBatches.findIndex((sb) => sb.id === id);
    return i >= 0 ? i + 1 : null;
  };
  return (
    <section className="hr-stack" style={{ gap: 8 }} data-testid="cupping-guest-feedback">
      <SecHead title={L("ملاحظات الضيوف", "Guest feedback")} caption={L("للاطلاع فقط · لا تدخل في المتوسط الرسمي", "For reference · not in the official average")} />
      <div className="hr-tablewrap">
        <table className="hr-table is-mrow" aria-label={L("ملاحظات الضيوف", "Guest feedback")}>
          <thead>
            <tr>
              <th>{L("الضيف", "Guest")}</th>
              {session.sessionBatches.length > 0 ? <th>{L("الكوب", "Cup")}</th> : null}
              <th className="num">{L("النتيجة", "Score")}</th>
              <th>{L("الملاحظات", "Comments")}</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => (
              <tr key={g.id}>
                <td className="m-title">{g.externalName ?? L("ضيف", "Guest")}</td>
                {session.sessionBatches.length > 0 ? <td><span className="hr-num">{cupNo(g.sessionBatchId) ?? "—"}</span></td> : null}
                <td className="num"><span className="hr-num">{g.finalScore.toFixed(2)}</span></td>
                <td>
                  <span className="hr-caption" style={{ margin: 0 }}>
                    {[g.notes, g.flavorDescriptors.map((d) => descriptorLabel(d, lang)).join(L("، ", ", "))].filter(Boolean).join(" · ") || "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ResultsView({ session }: { session: Session }) {
  const L = useL();
  // Owner decision 4: the official results are the staff panel's; guests are shown apart.
  const scores = session.scores.filter((s) => s.employeeId !== null);
  const guests = session.scores.filter((s) => s.employeeId === null);
  const noStaff = scores.length === 0
    ? <OpsEmpty title={L("لا توجد تقييمات من الموظفين لهذه الجلسة.", "No staff scores for this session.")} />
    : null;
  // G-07 composition (parity N-09): the cup cards, then the two-column panel results, both
  // from the staff scores only; an incomplete close labels the panel as not final (E6 / C-2).
  return (
    <div className="hr-stack ops-results" style={{ gap: 32 }}>
      {session.sessionBatches.length > 0 ? <CupCards session={session} scores={scores} /> : null}
      {noStaff ?? (
        <>
          {session.closeKind === "INCOMPLETE" ? <SecHead title={L("ملخص اللجنة · غير نهائي", "Panel summary · not final")} /> : null}
          <AggregateResults scores={scores} />
        </>
      )}
      <GuestFeedback session={session} guests={guests} />
    </div>
  );
}

/** The session page inside the operations Direction 2.1 scope (tokens, type, shell). */
export default function SessionPage(props: { params: Promise<{ id: string }> }) {
  return (
    <OpsRoot>
      <SessionPageInner {...props} />
    </OpsRoot>
  );
}

function SessionPageInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const user = useUser();
  const L = useL();
  const { lang } = useI18n();

  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // null = cup-picker list; a sessionBatch id = scoring that cup
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  // G-20/G-21: Cupping Results labels are printed from the session (labels.print; the API
  // re-checks it and the cupping access, and prints no score that is not final).
  const [printOpen, setPrintOpen] = useState(false);
  const canPrintLabels = hasSubPrivilege(user?.permissions ?? {}, "labels", "print");
  // The print certification gate (A-8): disabled with the explanation until the server says
  // printing is enabled; the print APIs refuse on the server either way.
  const printCertified = usePrintCertified();

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
      const j = await res.json().catch(() => ({}));
      // G-90: the two refusals the server gives a scorer, in the viewer's language.
      const msg: string = j.error || "";
      setSubmitError(/closed/i.test(msg) ? L("الجلسة مغلقة — لا تُقبل تقييمات جديدة.", "The session is closed — no new scores are accepted.")
        : /already scored/i.test(msg) ? L("قيّمت هذا الكوب مسبقًا.", "You have already scored this cup.")
        : msg || L("تعذّر إرسال التقييم.", "The score could not be submitted."));
      setSubmitting(false);
      return;
    }
    setActiveBatchId(null);
    await fetchSession();
    setSubmitting(false);
  }

  if (loading) return <div className="hr-page"><OpsLoading rows={4} label={L("جارٍ تحميل الجلسة…", "Loading session…")} /></div>;

  if (!session) {
    return (
      <div className="hr-page">
        <OpsEmpty title={L("الجلسة غير موجودة", "Session not found")} action={<Btn onClick={() => router.push("/dashboard/cupping")}>{L("العودة إلى التذوق", "Back to cupping")}</Btn>} />
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
  const activeCupIndex = session.sessionBatches.findIndex((sb) => sb.id === activeBatchId);

  // Owner decision 4: guests are supplementary; the header counts the official panel.
  const staffCount = session.scores.filter((s) => s.employeeId !== null).length;
  const guestCount = session.scores.length - staffCount;
  const header = (
    <>
      <button type="button" className="ops-link" style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", width: "fit-content", display: "inline-flex", alignItems: "center", gap: 4 }}
        onClick={() => { if (activeBatchId) { setActiveBatchId(null); return; } router.push("/dashboard/cupping"); }}>
        <ChevronLeft size={16} aria-hidden="true" style={{ transform: lang === "ar" ? "scaleX(-1)" : undefined }} />
        {activeBatchId ? L("كل الأكواب", "All cups") : L("كل الجلسات", "All sessions")}
      </button>
      {/* N-09 (G-07): a closed session is its results page — «جلسة 5 أكتوبر · النتائج», and the
          meta counts the cups and the official (staff) scores, guests apart — «تقييمان · ضيف واحد»
          (owner decision 4). E6: an incomplete close reads «غير مكتملة». */}
      <PageHeader title={isClosed ? <>{session.name} · {L("النتائج", "Results")}</> : session.name}>
        <StatusDot map={{ Open: [L("مفتوحة", "Open"), "info"], Closed: [L("مغلقة", "Closed"), "success"], Incomplete: [L("غير مكتملة", "Incomplete"), "warning"] }} value={session.status === "Closed" && session.closeKind === "INCOMPLETE" ? "Incomplete" : session.status} />
        {isClosed ? <span>{isMultiCup ? <>{countNoun(session.sessionBatches.length, lang, CUP_FORMS)} · </> : null}{countNoun(staffCount, lang, SCORE_FORMS)}{guestCount > 0 ? <> · {countNoun(guestCount, lang, GUEST_FORMS)}</> : null}</span> : null}
        <span className="hr-num">{opsDate(session.date, lang)}</span>
        {session.batch ? <span>{L("الدفعة", "Batch")} <span className="ops-serial">{session.batch.batchNumber}</span></span> : null}
        {session.greenBean ? <span>{session.greenBean.beanType} <span className="ops-serial">#{session.greenBean.serialNumber}</span></span> : null}
        {isMultiCup && activeBatchId ? <strong style={{ fontWeight: 600 }}>{L("كوب", "Cup")} <span className="hr-num">{activeCupIndex + 1}</span> {L("من", "of")} <span className="hr-num">{session.sessionBatches.length}</span></strong> : null}
        {canPrintLabels && !activeBatchId ? <Btn size="sm" onClick={() => setPrintOpen(true)} data-testid="cupping-print-labels" disabled={printCertified !== true} aria-describedby={printCertified === false ? PRINT_GATE_NOTE_ID : undefined}>{L("طباعة ملصقات النتائج", "Print result labels")}</Btn> : null}
      </PageHeader>
      {canPrintLabels && !activeBatchId && printCertified === false ? <PrintNotCertifiedNotice /> : null}
      {printOpen && printCertified === true ? (
        <PrintDialog open onClose={() => setPrintOpen(false)} initialTemplate="CUPPING_RESULTS" onPrinted={() => setPrintOpen(false)}
          subtitle={`${session.name} · ${session.status === "Open" ? L("مفتوحة", "open") : session.closeKind === "COMPLETE" ? L("مكتملة", "complete") : session.closeKind === "INCOMPLETE" ? L("غير مكتملة", "incomplete") : L("مغلقة", "closed")} · ${countNoun(Math.max(1, session.sessionBatches.length), lang === "ar" ? "ar" : "en", ["كوب واحد", "كوبان", "أكواب", "كوبًا", "cup", "cups"])}`}
          items={(session.sessionBatches.length > 0
            ? session.sessionBatches.map((sb, i) => ({ kind: "cup", sessionId: session.id, cupId: sb.id, label: `${L("كوب", "Cup")} ${i + 1} · ${sb.isExternalSample ? (sb.externalSampleName ?? L("عينة خارجية", "External sample")) : (sb.batch?.greenBean?.beanType ?? sb.batch?.orderItem?.beanTypeName ?? "—")}` }))
            : [{ kind: "cup", sessionId: session.id, cupId: null, label: session.name }]) as DialogItem[]} />
      ) : null}
    </>
  );

  const errorBox = submitError ? <Notice tone="danger">{submitError}</Notice> : null;
  // The results use the sheet's width (G-07 two-column composition); scoring stays at 960.
  // `after` carries the scorer status (owner decision 3) below the page's content.
  const page = (children: React.ReactNode, after?: React.ReactNode) => <div className="hr-page" style={isClosed ? undefined : { maxWidth: 960 }}>{header}{children}{after}</div>;

  if (isClosed) {
    return page(<>
      <IncompleteNotice session={session} />
      {session.scores.length === 0
        ? <OpsEmpty title={L("لم تُرسل تقييمات لهذه الجلسة.", "No scores were submitted for this session.")} />
        : <ResultsView session={session} />}
      <ScorerStatus session={session} />
    </>);
  }

  if (!isMultiCup && hasAllScored) {
    const mine = myScores[0]!;
    return page(
      <Notice tone="success">
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><CheckCircle size={18} aria-hidden="true" /> <strong style={{ fontWeight: 600 }}>{L("أُرسل تقييمك", "Score submitted")}</strong> · <span className="hr-num">{mine.finalScore.toFixed(2)}</span></span>
        {mine.flavorDescriptors.length > 0 ? <div>{L("الواصفات", "Descriptors")}: {mine.flavorDescriptors.map((d) => descriptorLabel(d, lang)).join(L("، ", ", "))}</div> : null}
        <div className="hr-caption">{L("بانتظار إغلاق الجلسة وكشف التقييمات.", "Waiting for the session to be closed and the scores revealed.")}</div>
      </Notice>,
      <ScorerStatus session={session} />,
    );
  }

  if (!isMultiCup) {
    return page(<>{errorBox}<CuppingForm onSubmit={handleSubmit} submitting={submitting} submitLabel={L("إرسال تقييمي", "Submit my score")} /></>, <ScorerStatus session={session} />);
  }

  if (hasAllScored) {
    return page(
      <>
        <Notice tone="success"><strong style={{ fontWeight: 600 }}>{L("قيّمت كل الأكواب", "All cups scored")}</strong> · {L("بانتظار إغلاق الجلسة وكشف التقييمات.", "Waiting for the session to be closed and the scores revealed.")}</Notice>
        <ul className="ops-list">
          {session.sessionBatches.map((sb, i) => {
            const cs = myScores.find((s) => s.sessionBatchId === sb.id);
            return <li key={sb.id}><span>{L("كوب", "Cup")} <span className="hr-num">{i + 1}</span></span>{cs ? <strong className="hr-num">{cs.finalScore.toFixed(2)}</strong> : null}</li>;
          })}
        </ul>
      </>,
      <ScorerStatus session={session} />,
    );
  }

  if (activeBatchId) {
    return page(<>{errorBox}<CuppingForm onSubmit={handleSubmit} submitting={submitting} submitLabel={L(`إرسال تقييم الكوب ${activeCupIndex + 1}`, `Submit cup ${activeCupIndex + 1} score`)} /></>);
  }

  // Cup picker
  const remaining = session.sessionBatches.filter((sb) => !scoredBatchIds.has(sb.id));
  return page(
    <section className="hr-stack" style={{ gap: 8 }}>
      <SecHead title={scoredBatchIds.size > 0
        ? <><span className="hr-num">{remaining.length}</span> {L("أكواب متبقية", remaining.length === 1 ? "cup remaining" : "cups remaining")}</>
        : L("اختر كوبًا للبدء", "Choose a cup to start scoring")} />
      <ul className="ops-queue">
        {session.sessionBatches.map((sb, i) => {
          const done = scoredBatchIds.has(sb.id);
          const cs = myScores.find((s) => s.sessionBatchId === sb.id);
          return (
            <li key={sb.id} className="ops-qrow">
              <button type="button" className="ops-qhead" disabled={done} onClick={() => !done && setActiveBatchId(sb.id)}>
                <span className="ops-qmain">
                  <span className="ops-qtitle">{L("كوب", "Cup")} <span className="hr-num">{i + 1}</span></span>
                  <span className="ops-sub">{done ? <>{L("قُيّم", "Scored")} · <span className="hr-num">{cs?.finalScore.toFixed(2) ?? ""}</span></> : L("اضغط لتقييم هذا الكوب", "Tap to score this cup")}</span>
                </span>
                <span className="ops-qend">{done ? <span className="hr-dot tone-success"><span>{L("مكتمل", "Done")}</span></span> : null}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>,
    <ScorerStatus session={session} />,
  );
}
