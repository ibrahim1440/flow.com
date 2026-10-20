"use client";
import { Combobox, Select } from "@/components/ui/Select";
import { useCreateRequest } from "@/components/shell/page-context";
import { Plus } from "lucide-react";
// HR-08 · Recruitment (Figma 1JbZgpMqmPkUVne8ms9Ozz · 454:21515). Split list + preview.
// Conversion to an employee is one idempotent server transaction: it never creates a login
// and converting twice returns the same person.
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Btn, Dialog, Empty, ErrorState, Field, KV, LoadingTable, NoPermission, Notice, PageHeader, STAGE,
  StatusDot, Tabs, hrFetch, money, statusLabel, todayIso, useAction, useCan, useForm, useHr, useHrI18n, useHrMeta, type StatusEntry, dateTimeIn,
  FilterChip,
} from "@/components/hr/ui";
import { orgName } from "@/lib/i18n/hr";

type Interview = { id: string; scheduledAt: string; kind: string; outcome: string; notes: string | null };
type Offer = {
  id: string; jobTitle: string; basic: string; housing: string; transport: string; otherAllowance: string; startDate: string;
  contractType: "FIXED_TERM" | "OPEN_ENDED"; contractMonths: number | null; probationDays: number | null; noticeDays: number; status: string; decidedAt: string | null;
};
type Applicant = {
  id: string; applicantNo: string; fullName: string; email: string | null; phone: string | null; source: string | null; stage: string; notes: string | null;
  openingId: string | null; opening: { code: string; title: string } | null; interviews: Interview[]; offers: Offer[]; hiredEmployee: { id: string; employeeNo: string } | null;
};
type Opening = {
  id: string; code: string; title: string; openings: number; status: string; createdAt: string;
  department: { nameAr: string; nameEn?: string | null } | null; branch: { code: string; nameAr: string | null; nameEn?: string | null } | null; _count: { applicants: number };
};
type View = "applicants" | "openings" | "interviews";

const OPENING_STATUS: Record<string, StatusEntry> = { OPEN: ["مفتوحة", "success", "Open"], ON_HOLD: ["معلّقة", "warning", "On hold"], CLOSED: ["مغلقة", "cancelled", "Closed"] };
const OFFER_STATUS: Record<string, StatusEntry> = { DRAFT: ["مسودة", "neutral", "Draft"], SENT: ["عرض مُرسل", "warning", "Offer sent"], ACCEPTED: ["عرض مقبول", "success", "Offer accepted"], DECLINED: ["عرض مرفوض", "danger", "Offer declined"], WITHDRAWN: ["عرض مسحوب", "cancelled", "Offer withdrawn"] };
const OUTCOME: Record<string, StatusEntry> = { PENDING: ["لم تُعقد", "neutral", "Not held"], PASS: ["مناسب", "success", "Suitable"], FAIL: ["غير مناسب", "danger", "Not suitable"], NO_SHOW: ["لم يحضر", "cancelled", "No-show"] };
const NEXT_LABEL: Record<string, [string, string, string]> = { APPLIED: ["SCREENING", "نقل إلى الفرز", "Move to screening"], SCREENING: ["INTERVIEW", "نقل إلى المقابلة", "Move to interview"], INTERVIEW: ["OFFER", "نقل إلى العرض", "Move to offer"] };
const OPEN_STAGES = ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"];

/** "2026-10-13T07:00:00.000Z" → "2026-10-13 10:00" in the viewer's local time, Latin digits. */
const when = (iso: string) => dateTimeIn(iso);
const nextInterview = (a: Applicant, nowIso: string) => a.interviews.find((i) => i.outcome === "PENDING" && i.scheduledAt >= nowIso) ?? null;
const currentOffer = (a: Applicant) => a.offers.find((o) => o.status === "ACCEPTED") ?? a.offers.find((o) => o.status === "SENT") ?? a.offers[0] ?? null;

export default function RecruitmentPage() {
  const can = useCan();
  const { meta } = useHrMeta();
  const allowed = !meta || meta.caps.recruit;
  const [view, setView] = useState<View>("applicants");
  const [stage, setStage] = useState("active");
  const [openingFilter, setOpeningFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"opening" | "applicant" | null>(null);
  // «جديد» from the shell (A-3): `?new=applicant` / `?new=opening` open the header's own forms.
  useCreateRequest("applicant", () => setDialog("applicant"), can("recruit"));
  useCreateRequest("opening", () => setDialog("opening"), can("recruit"));
  // Fixed per mount; "upcoming" only needs minute-level precision and a reload refreshes it.
  const [nowIso] = useState(() => new Date().toISOString());
  const { L, t, lang } = useHrI18n();

  const list = useHr<Applicant[]>(allowed ? `/api/hr/recruitment/applicants?stage=${encodeURIComponent(stage)}` : null);
  const active = useHr<Applicant[]>(allowed && stage !== "active" ? "/api/hr/recruitment/applicants?stage=active" : null);
  const openings = useHr<Opening[]>(allowed ? "/api/hr/recruitment/openings" : null);
  const activeRows = stage === "active" ? list.data : active.data;

  const upcoming = useMemo(() => {
    const out: { a: Applicant; i: Interview }[] = [];
    for (const a of activeRows ?? []) for (const i of a.interviews) if (i.outcome === "PENDING" && i.scheduledAt >= nowIso) out.push({ a, i });
    return out.sort((x, y) => x.i.scheduledAt.localeCompare(y.i.scheduledAt));
  }, [activeRows, nowIso]);

  const rows = useMemo(() => (list.data ?? []).filter((a) => !openingFilter || a.openingId === openingFilter), [list.data, openingFilter]);
  const selectedRow = list.data?.find((a) => a.id === selected) ?? activeRows?.find((a) => a.id === selected) ?? null;

  if (!allowed) return <div className="hr-page"><NoPermission duty={L("التوظيف", "Recruitment")} /></div>;

  const reloadAll = () => {
    void list.reload();
    if (stage !== "active") void active.reload();
    void openings.reload();
  };

  return (
    <div className={`hr-split${selectedRow ? " has-preview" : ""}`}>
      <div className="hr-page">
        <PageHeader
          title={L("التوظيف", "Recruitment")}
          actions={<>
            <Btn variant="primary" onClick={() => setDialog("applicant")}><Plus aria-hidden="true" /> {L("متقدم جديد", "New applicant")}</Btn>
            <Btn onClick={() => setDialog("opening")}><Plus aria-hidden="true" /> {L("وظيفة شاغرة", "Vacancy")}</Btn>
          </>}
        />
        <Tabs
          label={L("عروض التوظيف", "Recruitment views")}
          value={view}
          onChange={setView}
          items={[
            { key: "applicants", label: L("المتقدمون", "Applicants"), count: list.data ? rows.length : undefined },
            { key: "openings", label: L("الوظائف الشاغرة", "Vacancies"), count: openings.data?.filter((o) => o.status === "OPEN").length },
            { key: "interviews", label: L("المقابلات القادمة", "Upcoming interviews"), count: activeRows ? upcoming.length : undefined },
          ]}
        />

        {view === "applicants" ? (
          <>
            <div className="hr-filterbar">
              {/* Default view is «نشطة»: clearing returns to it; «الكل» is an explicit choice. */}
              <FilterChip
                label={L("المرحلة", "Stage")}
                allLabel={L("نشطة", "Active")}
                value={stage === "active" ? "" : stage === "" ? "all" : stage}
                onChange={(v) => setStage(v === "" ? "active" : v === "all" ? "" : v)}
                options={[{ value: "all", label: t("all") }, ...Object.keys(STAGE).map((k) => ({ value: k, label: statusLabel(STAGE, k, lang) }))]}
              />
              {openings.data?.length ? (
                <FilterChip label={L("الوظيفة", "Position")} value={openingFilter} onChange={setOpeningFilter} options={openings.data.map((o) => ({ value: o.id, label: o.title }))} />
              ) : null}
              {stage !== "active" || openingFilter ? <Btn variant="ghost" size="sm" onClick={() => { setStage("active"); setOpeningFilter(""); }}>{L("مسح المرشحات", "Clear filters")}</Btn> : null}
            </div>
            {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
            {list.loading && !list.data ? <LoadingTable /> : null}
            {list.data && rows.length === 0 ? (
              stage === "active" && !openingFilter
                ? <Empty title={L("لا متقدمون نشطون", "No active applicants")} body={L("أضف متقدمًا وابدأ الفرز. التحويل إلى موظف يتم بعد قبول عرض وظيفي.", "Add an applicant and start screening. Conversion to an employee happens after a job offer is accepted.")} action={<Btn variant="primary" onClick={() => setDialog("applicant")}>{L("متقدم جديد", "New applicant")}</Btn>} />
                : <Empty title={L("لا متقدم يطابق", "No matching applicant")} body={L("غيّر المرحلة أو الوظيفة.", "Change the stage or the position.")} action={<Btn size="sm" onClick={() => { setStage("active"); setOpeningFilter(""); }}>{L("مسح المرشحات", "Clear filters")}</Btn>} />
            ) : null}
            {rows.length > 0 ? (
              <div className="hr-tablewrap">
                <table className="hr-table is-mrow is-clip-sub" aria-label={L("المتقدمون", "Applicants")}>
                  <thead>
                    <tr><th>{L("الرقم", "No.")}</th><th>{L("المتقدم", "Applicant")}</th><th>{L("الوظيفة", "Position")}</th><th>{L("المرحلة", "Stage")}</th><th className="num">{L("المقابلة القادمة", "Next interview")}</th><th className="hr-hide-compact">{L("المصدر", "Source")}</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const ni = nextInterview(a, nowIso);
                      return (
                        <tr key={a.id} className="is-clickable" aria-selected={selected === a.id} tabIndex={0} onClick={() => setSelected(a.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(a.id); } }}>
                          <td data-label={L("الرقم", "No.")}><span className="hr-id">{a.applicantNo}</span></td>
                          <td data-label={L("المتقدم", "Applicant")} className="strong m-title">{a.fullName}<span className="hr-msub"><span className="hr-id">{a.applicantNo}</span> · {a.opening?.title ?? "—"}{ni ? <span className="hr-msub-tail"> · {L("مقابلة", "interview")} <span className="hr-num">{when(ni.scheduledAt)}</span></span> : null}</span></td>
                          <td data-label={L("الوظيفة", "Position")}>{a.opening?.title ?? "—"}</td>
                          <td data-label={L("المرحلة", "Stage")} className="m-end"><StageCell a={a} /></td>
                          <td data-label={L("المقابلة القادمة", "Next interview")} className="num">{ni ? when(ni.scheduledAt) : "—"}</td>
                          <td data-label={L("المصدر", "Source")} className="hr-hide-compact hr-muted">{a.source ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}

        {view === "openings" ? <Openings q={openings} canManage={can("recruit")} onNew={() => setDialog("opening")} /> : null}

        {view === "interviews" ? (
          <>
            {(stage === "active" ? list.error : active.error) ? <ErrorState error={(stage === "active" ? list.error : active.error)!} onRetry={reloadAll} /> : null}
            {!activeRows ? <LoadingTable /> : upcoming.length === 0 ? (
              <Empty title={L("لا مقابلات قادمة", "No upcoming interviews")} body={L("تُجدول المقابلة من معاينة المتقدم في مرحلة الفرز أو المقابلة.", "Interviews are scheduled from the applicant preview in the screening or interview stage.")} />
            ) : (
              <div className="hr-tablewrap">
                <table className="hr-table is-stack" aria-label={L("المقابلات القادمة", "Upcoming interviews")}>
                  <thead><tr><th className="num">{L("الموعد", "Time")}</th><th>{L("المتقدم", "Applicant")}</th><th>{L("الوظيفة", "Position")}</th><th>{L("النوع", "Type")}</th><th className="hr-hide-compact">{L("ملاحظات", "Notes")}</th></tr></thead>
                  <tbody>
                    {upcoming.map(({ a, i }) => (
                      <tr key={i.id} className="is-clickable" tabIndex={0} aria-selected={selected === a.id} onClick={() => setSelected(a.id)} onKeyDown={(e) => { if (e.key === "Enter") setSelected(a.id); }}>
                        <td data-label={L("الموعد", "Time")} className="num">{when(i.scheduledAt)}</td>
                        <td data-label={L("المتقدم", "Applicant")} className="strong">{a.fullName}<span className="sub hr-id">{a.applicantNo}</span></td>
                        <td data-label={L("الوظيفة", "Position")}>{a.opening?.title ?? "—"}</td>
                        <td data-label={L("النوع", "Type")}>{i.kind}</td>
                        <td data-label={L("ملاحظات", "Notes")} className="hr-hide-compact hr-muted">{i.notes ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>

      {selectedRow ? (
        <>
          <div className="hr-scrim" onClick={() => setSelected(null)} />
          <Preview a={selectedRow} nowIso={nowIso} onClose={() => setSelected(null)} onChanged={reloadAll} />
        </>
      ) : null}
      {dialog === "opening" ? <NewOpening onClose={() => setDialog(null)} onDone={() => { setDialog(null); void openings.reload(); setView("openings"); }} /> : null}
      {dialog === "applicant" ? (
        <NewApplicant openings={(openings.data ?? []).filter((o) => o.status === "OPEN")} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); setView("applicants"); reloadAll(); setSelected(id); }} />
      ) : null}
    </div>
  );
}

function StageCell({ a }: { a: Applicant }) {
  const { L } = useHrI18n();
  if (a.stage === "HIRED" && a.hiredEmployee) {
    return (
      <Link href={`/dashboard/hr/employees/${a.hiredEmployee.id}`} className="hr-dot tone-success" onClick={(e) => e.stopPropagation()}>
        <span style={{ fontWeight: 600 }}>{L("تم التوظيف", "Hired")} · <span className="hr-num">{a.hiredEmployee.employeeNo}</span></span>
      </Link>
    );
  }
  if (a.stage === "OFFER") {
    const o = currentOffer(a);
    if (o && (o.status === "SENT" || o.status === "ACCEPTED")) return <StatusDot map={OFFER_STATUS} value={o.status} />;
  }
  return <StatusDot map={STAGE} value={a.stage} />;
}

function Openings({ q, canManage, onNew }: { q: ReturnType<typeof useHr<Opening[]>>; canManage: boolean; onNew: () => void }) {
  const a = useAction();
  const { L, lang } = useHrI18n();
  const setStatus = (id: string, status: string) => a.run(id, async () => {
    await hrFetch(`/api/hr/recruitment/openings/${id}/status`, { json: { status } });
    await q.reload();
  });
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return <LoadingTable />;
  if (!q.data.length) return <Empty title={L("لا وظائف شاغرة", "No vacancies")} body={L("أنشئ وظيفة شاغرة لربط المتقدمين بها. ربط المتقدم بوظيفة اختياري.", "Create a vacancy to link applicants to. Linking an applicant to a vacancy is optional.")} action={<Btn variant="primary" onClick={onNew}>{L("وظيفة شاغرة", "Vacancy")}</Btn>} />;
  return (
    <>
      {a.error ? <Notice tone="danger">{a.error}</Notice> : null}
      <div className="hr-tablewrap">
        <table className="hr-table is-stack" aria-label={L("الوظائف الشاغرة", "Vacancies")}>
          <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الوظيفة", "Position")}</th><th>{L("الإدارة · الفرع", "Department · Branch")}</th><th className="num">{L("العدد", "Openings")}</th><th className="num">{L("المتقدمون", "Applicants")}</th><th>{L("الحالة", "Status")}</th><th /></tr></thead>
          <tbody>
            {q.data.map((o) => (
              <tr key={o.id}>
                <td data-label={L("الرمز", "Code")}><span className="hr-id">{o.code}</span></td>
                <td data-label={L("الوظيفة", "Position")} className="strong">{o.title}</td>
                <td data-label={L("الإدارة · الفرع", "Department · Branch")} className="hr-muted">{[o.department ? orgName(o.department, lang) : null, o.branch ? (lang === "en" ? o.branch.nameEn || o.branch.code : o.branch.nameAr ?? o.branch.code) : null].filter(Boolean).join(" · ") || "—"}</td>
                <td data-label={L("العدد", "Openings")} className="num">{o.openings}</td>
                <td data-label={L("المتقدمون", "Applicants")} className="num">{o._count.applicants}</td>
                <td data-label={L("الحالة", "Status")}><StatusDot map={OPENING_STATUS} value={o.status} /></td>
                <td data-label={L("تغيير الحالة", "Change status")}>
                  {canManage ? (
                    <Select className="hr-select" style={{ height: "var(--hr-control-sm)", width: "auto" }} aria-label={L(`حالة ${o.code}`, `${o.code} status`)} value={o.status} disabled={a.busy === o.id} onChange={(e) => setStatus(o.id, e.target.value)}>
                      {Object.keys(OPENING_STATUS).map((k) => <option key={k} value={k}>{statusLabel(OPENING_STATUS, k, lang)}</option>)}
                    </Select>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Preview ────────────────────────────────────────────────────────────────────────

type Pane = null | "interview" | "offer" | "hire" | { stage: string; label: string };

function Preview({ a, nowIso, onClose, onChanged }: { a: Applicant; nowIso: string; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const act = useAction();
  const [pane, setPane] = useState<Pane>(null);
  const [hired, setHired] = useState<{ employeeId: string; replayed: boolean } | null>(null);
  const offer = currentOffer(a);
  const accepted = a.offers.find((o) => o.status === "ACCEPTED") ?? null;
  const sent = a.offers.find((o) => o.status === "SENT") ?? null;
  const open = OPEN_STAGES.includes(a.stage);
  const next = NEXT_LABEL[a.stage];
  const canHire = can("recruit") && can("people_manage") && can("contracts_manage");
  const { L, lang } = useHrI18n();

  const post = (key: string, url: string, json: unknown = {}) => act.run(key, async () => {
    await hrFetch(url, { json });
    onChanged();
  });

  return (
    <aside className="hr-preview" aria-label={L("معاينة المتقدم", "Applicant preview")}>
      <div className="hr-preview-head">
        <span className="hr-id">{a.applicantNo}</span>
        <Btn variant="ghost" size="sm" aria-label={L("إغلاق المعاينة", "Close preview")} onClick={onClose}>✕</Btn>
      </div>
      <div className="hr-preview-body">
        <div>
          <h2 className="hr-mobile-title">{a.fullName}</h2>
          <div className="hr-caption">{[a.opening?.title, a.opening?.code].filter(Boolean).join(" · ") || L("غير مرتبط بوظيفة شاغرة", "Not linked to a vacancy")}</div>
        </div>
        <div className="hr-meta"><StageCell a={a} /></div>
        {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
        {hired ? (
          <Notice tone="success">
            {hired.replayed ? L("سبق تحويل هذا المتقدم؛ لم يُنشأ ملف ثانٍ. ", "This applicant was already converted; no second file was created. ") : L("أُنشئ ملف الموظف. ", "The employee file was created. ")}
            <Link href={`/dashboard/hr/employees/${hired.employeeId}`}>{L("فتح ملف الموظف ←", "Open employee file →")}</Link>
          </Notice>
        ) : null}

        <KV rows={[
          [L("الجوال", "Mobile"), a.phone ? <span key="p" className="hr-num">{a.phone}</span> : "—"],
          [L("البريد", "Email"), a.email ? <span key="e" className="hr-num">{a.email}</span> : "—"],
          [L("المصدر", "Source"), a.source ?? "—"],
        ]} />
        {a.notes ? <p className="hr-caption" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{a.notes}</p> : null}

        <span className="hr-section">{L("المقابلات", "Interviews")}</span>
        {a.interviews.length ? (
          <dl className="hr-kv">
            {a.interviews.map((i) => (
              <div key={i.id}>
                <dt>{i.kind}{i.notes ? <span className="hr-caption"> · {i.notes}</span> : null}</dt>
                <dd style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <span><span className="hr-num">{when(i.scheduledAt)}</span> · <StatusDot map={OUTCOME} value={i.outcome} /></span>
                  {i.outcome === "PENDING" && open ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      {(["PASS", "FAIL", "NO_SHOW"] as const).map((o) => (
                        <Btn key={o} size="sm" variant="ghost" busy={act.busy === `${i.id}:${o}`} onClick={() => post(`${i.id}:${o}`, `/api/hr/recruitment/interviews/${i.id}/outcome`, { outcome: o })}>{statusLabel(OUTCOME, o, lang)}</Btn>
                      ))}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : <span className="hr-caption">{L("لا مقابلات بعد.", "No interviews yet.")}</span>}

        <span className="hr-section">{L("العرض الوظيفي", "Job offer")}</span>
        {offer ? (
          <KV rows={[
            [L("المسمى", "Title"), offer.jobTitle],
            [L("الراتب المعروض", "Offered salary"), <span key="s" className="hr-num">{money(offer.basic)} + {money(Number(offer.housing) + Number(offer.transport) + Number(offer.otherAllowance))}</span>],
            [L("تاريخ المباشرة المقترح", "Proposed start date"), <span key="d" className="hr-num">{offer.startDate}</span>],
            [L("العقد", "Contract"), offer.contractType === "FIXED_TERM" ? L(`محدد المدة · ${offer.contractMonths} شهرًا`, `Fixed term · ${offer.contractMonths} months`) : L("غير محدد المدة", "Open-ended")],
            [L("فترة التجربة", "Probation"), offer.probationDays ? L(`${offer.probationDays} يومًا`, `${offer.probationDays} days`) : L("بلا فترة تجربة", "No probation")],
            [L("فترة الإشعار", "Notice period"), L(`${offer.noticeDays} يومًا`, `${offer.noticeDays} days`)],
            [L("حالة العرض", "Offer status"), <span key="st">{statusLabel(OFFER_STATUS, offer.status, lang)}{offer.decidedAt ? <> · <span className="hr-num">{offer.decidedAt.slice(0, 10)}</span></> : null}</span>, offer.status === "ACCEPTED" ? "success" : offer.status === "DECLINED" ? "danger" : undefined],
          ]} />
        ) : <span className="hr-caption">{a.stage === "OFFER" ? L("لم يُنشأ عرض بعد.", "No offer created yet.") : L("يُنشأ العرض بعد نقل المتقدم إلى مرحلة العرض.", "The offer is created after the applicant moves to the offer stage.")}</span>}

        <Notice tone="info">{L("التحويل ينشئ ملف موظف واحدًا من بيانات المتقدّم والعرض، ولا ينشئ حساب دخول. إعادة التحويل لا تُنشئ ملفًا ثانيًا. ربط حساب دخول قائم خطوة مستقلة.", "Conversion creates one employee file from the applicant and the offer, and no login account. Converting again does not create a second file. Linking an existing login is a separate step.")}</Notice>
        {accepted && !canHire && a.stage !== "HIRED" ? <p className="hr-caption" style={{ margin: 0 }}>{L("التحويل يحتاج صلاحيات «التوظيف» و«الموظفين» و«العقود والرواتب» معًا.", "Conversion needs the Recruitment, People and Contracts & payroll permissions together.")}</p> : null}
      </div>

      <div className="hr-preview-foot">
        {a.stage === "HIRED" && a.hiredEmployee ? <Link className="hr-btn is-primary" href={`/dashboard/hr/employees/${a.hiredEmployee.id}`}>{L("فتح ملف الموظف", "Open employee file")}</Link> : null}
        {accepted && a.stage !== "HIRED" ? <Btn variant="primary" disabled={!canHire} onClick={() => setPane("hire")}>{L("تحويل إلى موظف", "Convert to employee")}</Btn> : null}
        {a.stage === "OFFER" && sent ? (
          <>
            <Btn variant="primary" busy={act.busy === "acc"} onClick={() => post("acc", `/api/hr/recruitment/offers/${sent.id}/decide`, { decision: "ACCEPTED" })}>{L("قبول العرض", "Accept offer")}</Btn>
            <Btn busy={act.busy === "dec"} onClick={() => post("dec", `/api/hr/recruitment/offers/${sent.id}/decide`, { decision: "DECLINED" })}>{L("رفض العرض", "Decline offer")}</Btn>
          </>
        ) : null}
        {a.stage === "OFFER" && !sent && !accepted ? <Btn variant="primary" onClick={() => setPane("offer")}>{L("إنشاء عرض", "Create offer")}</Btn> : null}
        {next ? <Btn variant={a.stage === "INTERVIEW" && a.interviews.some((i) => i.outcome === "PASS") ? "primary" : "secondary"} onClick={() => setPane({ stage: next[0], label: lang === "en" ? next[2] : next[1] })}>{lang === "en" ? next[2] : next[1]}</Btn> : null}
        {a.stage === "SCREENING" || a.stage === "INTERVIEW" ? <Btn onClick={() => setPane("interview")}>{L("+ مقابلة", "+ Interview")}</Btn> : null}
        {open && !accepted ? (
          <>
            <Btn variant="ghost" onClick={() => setPane({ stage: "REJECTED", label: L("رفض المتقدم", "Reject applicant") })}>{L("رفض", "Reject")}</Btn>
            <Btn variant="ghost" onClick={() => setPane({ stage: "WITHDRAWN", label: L("تسجيل انسحاب", "Record withdrawal") })}>{L("انسحب", "Withdrew")}</Btn>
          </>
        ) : null}
      </div>

      {pane && typeof pane === "object" ? (
        <StageDialog a={a} stage={pane.stage} label={pane.label} onClose={() => setPane(null)} onDone={() => { setPane(null); onChanged(); }} />
      ) : null}
      {pane === "interview" ? <InterviewDialog a={a} nowIso={nowIso} onClose={() => setPane(null)} onDone={() => { setPane(null); onChanged(); }} /> : null}
      {pane === "offer" ? <OfferDialog a={a} onClose={() => setPane(null)} onDone={() => { setPane(null); onChanged(); }} /> : null}
      {pane === "hire" ? <HireDialog a={a} onClose={() => setPane(null)} onDone={(r) => { setPane(null); setHired(r); onChanged(); }} /> : null}
    </aside>
  );
}

function StageDialog({ a, stage, label, onClose, onDone }: { a: Applicant; stage: string; label: string; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const act = useAction();
  const submit = () => act.run("s", async () => {
    await hrFetch(`/api/hr/recruitment/applicants/${a.id}/stage`, { json: { stage, note: note || undefined } });
    onDone();
  });
  const terminal = stage === "REJECTED" || stage === "WITHDRAWN";
  const { L, en } = useHrI18n();
  return (
    <Dialog open title={label} onClose={onClose} actions={<><Btn variant={terminal ? "danger" : "primary"} busy={act.busy === "s"} onClick={submit}>{label}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <p style={{ margin: 0 }}>{a.fullName}: <StatusDot map={STAGE} value={a.stage} /> {en ? "→" : "←"} <StatusDot map={STAGE} value={stage} /></p>
      {terminal ? <p className="hr-caption" style={{ margin: 0 }}>{L("هذه مرحلة نهائية؛ لا يمكن إعادة المتقدم بعدها.", "This is a final stage; the applicant cannot be moved back after it.")}</p> : null}
      <Field label={L("ملاحظة (اختيارية)", "Note (optional)")} help={L("تُحفظ في سجل التدقيق.", "Kept in the audit log.")}><textarea className="hr-textarea" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function InterviewDialog({ a, nowIso, onClose, onDone }: { a: Applicant; nowIso: string; onClose: () => void; onDone: () => void }) {
  const { L } = useHrI18n();
  const f = useForm({ at: `${nowIso.slice(0, 10)}T10:00`, kind: L("فنية", "Technical"), notes: "" });
  const act = useAction();
  const submit = () => act.run("i", async () => {
    const at = new Date(f.v.at);
    if (Number.isNaN(at.getTime())) throw new Error(L("اختر موعدًا صحيحًا.", "Choose a valid time."));
    await hrFetch(`/api/hr/recruitment/applicants/${a.id}/interviews`, { json: { scheduledAt: at.toISOString(), kind: f.v.kind, notes: f.v.notes || undefined } });
    onDone();
  });
  return (
    <Dialog open title={L(`مقابلة · ${a.fullName}`, `Interview · ${a.fullName}`)} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "i"} disabled={!f.v.at || !f.v.kind.trim()} onClick={submit}>{L("جدولة", "Schedule")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الموعد *", "Time *")} help={L("بتوقيت جهازك.", "In your device’s time.")}><input className="hr-input" type="datetime-local" {...f.bind("at")} /></Field>
        <Field label={L("النوع *", "Type *")}><Combobox className="hr-input" maxLength={60} {...f.bind("kind")} options={L("فنية|إدارية|هاتفية|الموارد البشرية", "Technical|Management|Phone|HR").split("|").map((k) => ({ value: k }))} /></Field>
        <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-textarea" maxLength={1000} {...f.bind("notes")} /></Field>
      </div>
    </Dialog>
  );
}

function OfferDialog({ a, onClose, onDone }: { a: Applicant; onClose: () => void; onDone: () => void }) {
  const f = useForm({ jobTitle: a.opening?.title ?? "", basic: "", housing: "0", transport: "0", otherAllowance: "0", startDate: todayIso(), contractType: "FIXED_TERM", contractMonths: "12", probationDays: "90", noticeDays: "30" });
  const act = useAction();
  const submit = () => act.run("o", async () => {
    await hrFetch(`/api/hr/recruitment/applicants/${a.id}/offers`, {
      json: {
        jobTitle: f.v.jobTitle, basic: f.v.basic, housing: f.v.housing || "0", transport: f.v.transport || "0", otherAllowance: f.v.otherAllowance || "0", startDate: f.v.startDate,
        contractType: f.v.contractType, contractMonths: f.v.contractType === "FIXED_TERM" ? Number(f.v.contractMonths) : undefined,
        probationDays: f.v.probationDays === "" ? undefined : Number(f.v.probationDays), noticeDays: Number(f.v.noticeDays || 30),
      },
    });
    onDone();
  });
  const total = [f.v.basic, f.v.housing, f.v.transport, f.v.otherAllowance].reduce((s, v) => s + (Number(v) || 0), 0);
  const { L } = useHrI18n();
  return (
    <Dialog open title={L(`عرض وظيفي · ${a.fullName}`, `Job offer · ${a.fullName}`)} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "o"} disabled={!f.v.jobTitle || !f.v.basic || !f.v.startDate} onClick={submit}>{L("إرسال العرض", "Send offer")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("المسمى الوظيفي *", "Job title *")} wide><input className="hr-input" maxLength={120} {...f.bind("jobTitle")} /></Field>
        <Field label={L("الأساسي *", "Basic *")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("basic")} /></Field>
        <Field label={L("بدل السكن", "Housing allowance")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("housing")} /></Field>
        <Field label={L("بدل النقل", "Transport allowance")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("transport")} /></Field>
        <Field label={L("بدلات أخرى", "Other allowances")}><input className="hr-input hr-num" inputMode="decimal" {...f.bind("otherAllowance")} /></Field>
        <Field label={L("تاريخ المباشرة *", "Start date *")}><input className="hr-input" type="date" {...f.bind("startDate")} /></Field>
        <Field label={L("نوع العقد", "Contract type")}><Select className="hr-select" {...f.bind("contractType")}><option value="FIXED_TERM">{L("محدد المدة", "Fixed term")}</option><option value="OPEN_ENDED">{L("غير محدد المدة", "Open-ended")}</option></Select></Field>
        {f.v.contractType === "FIXED_TERM" ? <Field label={L("مدة العقد (شهر) *", "Contract length (months) *")}><input className="hr-input hr-num" type="number" min={1} max={120} {...f.bind("contractMonths")} /></Field> : null}
        <Field label={L("فترة التجربة (يوم)", "Probation (days)")} help={L("اتركها فارغة إن لم توجد.", "Leave empty if none.")}><input className="hr-input hr-num" type="number" min={0} max={365} {...f.bind("probationDays")} /></Field>
        <Field label={L("فترة الإشعار (يوم)", "Notice period (days)")}><input className="hr-input hr-num" type="number" min={0} max={365} {...f.bind("noticeDays")} /></Field>
      </div>
      <p className="hr-caption" style={{ margin: 0 }}>{L("الإجمالي الشهري:", "Monthly total:")} <span className="hr-num">{money(total)}</span>. {L("إرسال عرض جديد يسحب أي عرض سابق لم يُقرَّر.", "Sending a new offer withdraws any earlier undecided offer.")}</p>
    </Dialog>
  );
}

function HireDialog({ a, onClose, onDone }: { a: Applicant; onClose: () => void; onDone: (r: { employeeId: string; replayed: boolean }) => void }) {
  const { meta } = useHrMeta();
  const f = useForm({ branchId: meta?.branches.length === 1 ? meta.branches[0].id : "", departmentId: "", managerId: "", accountId: "" });
  const accounts = useHr<{ id: string; name: string; role: string; simpleModeException?: boolean }[]>("/api/hr/accounts/linkable");
  const act = useAction();
  const offer = a.offers.find((o) => o.status === "ACCEPTED");
  const { L, lang } = useHrI18n();
  const submit = () => act.run("h", async () => {
    const body = Object.fromEntries(Object.entries(f.v).filter(([, v]) => v !== ""));
    const r = await hrFetch<{ employeeId: string; replayed: boolean }>(`/api/hr/recruitment/applicants/${a.id}/hire`, { json: body });
    onDone(r);
  });
  return (
    <Dialog open title={L(`تحويل إلى موظف · ${a.fullName}`, `Convert to employee · ${a.fullName}`)} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "h"} onClick={submit}>{L("تحويل إلى موظف", "Convert to employee")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      {offer ? (
        <KV rows={[
          [L("المسمى", "Title"), offer.jobTitle],
          [L("تاريخ المباشرة", "Start date"), <span key="d" className="hr-num">{offer.startDate}</span>],
          [L("الراتب", "Salary"), <span key="s" className="hr-num">{money(offer.basic)} + {money(Number(offer.housing) + Number(offer.transport) + Number(offer.otherAllowance))}</span>],
        ]} />
      ) : null}
      <div className="hr-form">
        <Field label={L("الفرع", "Branch")}><Select className="hr-select" {...f.bind("branchId")}><option value="">—</option>{meta?.branches.map((b) => <option key={b.id} value={b.id}>{orgName(b, lang)}</option>)}</Select></Field>
        <Field label={L("الإدارة", "Department")}><Select className="hr-select" {...f.bind("departmentId")}><option value="">—</option>{meta?.departments.map((d) => <option key={d.id} value={d.id}>{orgName(d, lang)}</option>)}</Select></Field>
        <Field label={L("المدير المباشر", "Line manager")}><Select className="hr-select" {...f.bind("managerId")}><option value="">—</option>{meta?.people.map((p) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.employeeNo}</option>)}</Select></Field>
        <Field label={L("ربط حساب دخول قائم (اختياري)", "Link an existing login (optional)")} help={accounts.error ? accounts.error.message : L("يمكن ربطه لاحقًا من ملف الموظف.", "It can be linked later from the employee file.")}>
          <Select className="hr-select" {...f.bind("accountId")} disabled={!accounts.data}><option value="">{L("بلا حساب", "No account")}</option>{accounts.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        </Field>
      </div>
      {/* SIMPLE MODE: a privileged login is linked as a recorded control exception (the server decides and audits it). */}
      {accounts.data?.find((x) => x.id === f.v.accountId)?.simpleModeException ? <Notice tone="warning">{L("وضع التشغيل المبسّط: سيُسجَّل هذا الربط كاستثناء رقابي", "Simple operating mode: this link will be recorded as a control exception")}</Notice> : null}
      <Notice tone="info">{L("التحويل ينشئ ملف موظف واحدًا من بيانات المتقدّم والعرض، ولا ينشئ حساب دخول. إعادة التحويل لا تُنشئ ملفًا ثانيًا. ربط حساب دخول قائم خطوة مستقلة.", "Conversion creates one employee file from the applicant and the offer, and no login account. Converting again does not create a second file. Linking an existing login is a separate step.")}</Notice>
    </Dialog>
  );
}

// ── Create dialogs ─────────────────────────────────────────────────────────────────

function NewOpening({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { meta } = useHrMeta();
  const f = useForm({ code: "", title: "", departmentId: "", branchId: "", openings: "1" });
  const act = useAction();
  const { L, lang } = useHrI18n();
  const submit = () => act.run("o", async () => {
    await hrFetch("/api/hr/recruitment/openings", { json: { code: f.v.code, title: f.v.title, departmentId: f.v.departmentId || undefined, branchId: f.v.branchId || undefined, openings: Number(f.v.openings || 1) } });
    onDone();
  });
  return (
    <Dialog open title={L("وظيفة شاغرة", "Vacancy")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "o"} disabled={!f.v.code || !f.v.title} onClick={submit}>{L("حفظ", "Save")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الرمز *", "Code *")} help={L("مثل BAR-2026", "e.g. BAR-2026")}><input className="hr-input" dir="ltr" maxLength={20} {...f.bind("code")} /></Field>
        <Field label={L("عدد الشواغر", "Openings")}><input className="hr-input hr-num" type="number" min={1} max={100} {...f.bind("openings")} /></Field>
        <Field label={L("المسمى *", "Title *")} wide><input className="hr-input" maxLength={120} {...f.bind("title")} /></Field>
        <Field label={L("الإدارة", "Department")}><Select className="hr-select" {...f.bind("departmentId")}><option value="">—</option>{meta?.departments.map((d) => <option key={d.id} value={d.id}>{orgName(d, lang)}</option>)}</Select></Field>
        <Field label={L("الفرع", "Branch")}><Select className="hr-select" {...f.bind("branchId")}><option value="">—</option>{meta?.branches.map((b) => <option key={b.id} value={b.id}>{orgName(b, lang)}</option>)}</Select></Field>
      </div>
    </Dialog>
  );
}

function NewApplicant({ openings, onClose, onDone }: { openings: Opening[]; onClose: () => void; onDone: (id: string) => void }) {
  const f = useForm({ fullName: "", openingId: "", email: "", phone: "", source: "", notes: "" });
  const act = useAction();
  const { L } = useHrI18n();
  const submit = () => act.run("a", async () => {
    const body = Object.fromEntries(Object.entries(f.v).filter(([, v]) => v !== ""));
    const r = await hrFetch<{ id: string }>("/api/hr/recruitment/applicants", { json: body });
    onDone(r.id);
  });
  return (
    <Dialog open title={L("متقدم جديد", "New applicant")} onClose={onClose} actions={<><Btn variant="primary" busy={act.busy === "a"} disabled={!f.v.fullName.trim()} onClick={submit}>{L("حفظ", "Save")}</Btn><Btn onClick={onClose}>{L("إلغاء", "Cancel")}</Btn></>}>
      {act.error ? <Notice tone="danger">{act.error}</Notice> : null}
      <div className="hr-form">
        <Field label={L("الاسم الكامل *", "Full name *")} wide><input className="hr-input" maxLength={120} {...f.bind("fullName")} /></Field>
        <Field label={L("الوظيفة الشاغرة", "Vacancy")}><Select className="hr-select" {...f.bind("openingId")}><option value="">—</option>{openings.map((o) => <option key={o.id} value={o.id}>{o.title} · {o.code}</option>)}</Select></Field>
        <Field label={L("المصدر", "Source")}><Combobox className="hr-input" maxLength={60} {...f.bind("source")} options={L("موقع حقبة|إحالة|لينكدإن|مكتب توظيف", "Hiqbah website|Referral|LinkedIn|Recruitment agency").split("|").map((k) => ({ value: k }))} /></Field>
        <Field label={L("الجوال", "Mobile")}><input className="hr-input" dir="ltr" inputMode="tel" maxLength={40} {...f.bind("phone")} /></Field>
        <Field label={L("البريد", "Email")}><input className="hr-input" dir="ltr" type="email" maxLength={120} {...f.bind("email")} /></Field>
        <Field label={L("ملاحظات", "Notes")} wide><textarea className="hr-textarea" maxLength={1000} {...f.bind("notes")} /></Field>
      </div>
    </Dialog>
  );
}
