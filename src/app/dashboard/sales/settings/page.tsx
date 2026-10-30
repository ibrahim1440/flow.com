"use client";

import { Select } from "@/components/ui/Select";
import { useState, useEffect } from "react";
import {
  useLang, Button, Field, TextInput, Modal, Alert, api, num, LEAD_SOURCE_LABELS,
} from "../_components/ui";
import { PerfNotice, PerfLoading, PerfNote } from "../_components/perf";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
import { SettingsNav } from "../../_components/tools-ui";
import { DISCOUNT_APPROVAL_THRESHOLD, DISCOUNT_MAX } from "@/lib/services/sales/discount-limits";

/**
 * Pipeline configuration — Direction 2.1, GX A-P08 «المبيعات» settings (`1229:114164`, EN
 * `1233:79569`, 1024 `1230:19899`, 390 `1232:39315`).
 *
 * The board's columns are data, not constants in the client — which is the only way an
 * Arabic roastery gets to rename a stage without a deployment, and the only way anybody
 * reorders one at all.
 *
 * Two rules are visible here rather than hidden in the API:
 *
 *   - **A stage needs both an English and an Arabic name.** One without the other renders as
 *     a gap on the board most of these users actually work in.
 *   - **A stage holding deals cannot be retired.** The board would lose a column with cards
 *     in it and those deals would become invisible rather than moved. The count is shown
 *     next to the control that would do it, so the refusal is never a surprise.
 *
 * Retiring, never deleting: a stage is referenced by every stage event that ever mentioned
 * it, and deleting it would break the history those events exist to preserve.
 *
 * Visual port: the same requests (list, reorder, purpose, retire / restore, the stage dialog).
 * The frame's settings navigation column (المنشأة, المستخدمون…) is the settings hub's own
 * (`SettingsNav`, shared with the organisation and automation settings).
 */

type StagePurpose = "QUALIFICATION" | "SAMPLE_EVALUATION" | "QUOTATION" | "NEGOTIATION";

type Stage = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  position: number;
  probability: number;
  isActive: boolean;
  /** What the lifecycle automation means by this column. At most one stage per purpose. */
  purpose: StagePurpose | null;
  _count?: { opportunities: number };
  /** Deals in this stage that are still open — the only ones that stop it being hidden. */
  openDeals?: number;
};

/**
 * What each column means to the server, and what happens there — the approved pipeline in
 * order (docs/sales/PIPELINE_STAGES.md). «مغلقة» is not here: closing is the deal's outcome
 * (Won / Lost), not a column.
 *
 * Deliberately not matched against the stage's code or its name: the names are translated
 * and editable, and this deployment's codes are historical (`UAT_QUALIFY`, `UAT_PROPOSAL`).
 * Somebody has to say which column is which, once, here.
 */
const PURPOSE_LABELS: Record<StagePurpose, { en: string; ar: string; whenEn: string; whenAr: string; unsetEn: string; unsetAr: string }> = {
  QUALIFICATION: {
    en: "Qualified opportunity",
    ar: "فرصة مؤهلة",
    whenEn: "where a lead lands once qualified (needs analysis is recorded here)",
    whenAr: "حيث يصل العميل المحتمل بعد تأهيله (ويُسجَّل فيها تحليل الاحتياج)",
    unsetEn: "Not set — no lead will qualify automatically until a stage is chosen.",
    unsetAr: "غير مُهيَّأة — لن يتحوّل أي عميل محتمل تلقائيًا حتى تُحدَّد مرحلة.",
  },
  SAMPLE_EVALUATION: {
    en: "Sample evaluation",
    ar: "تجربة وتقييم العينات",
    whenEn: "moving a deal past it with no sample needs a documented reason",
    whenAr: "تجاوزها دون عيّنة على الصفقة يحتاج سببًا موثّقًا",
    unsetEn: "Not set — deals move past samples without a skip reason.",
    unsetAr: "غير مُهيَّأة — تتجاوز الصفقات العينات دون سبب تخطٍّ.",
  },
  QUOTATION: {
    en: "Quotation",
    ar: "عرض السعر",
    whenEn: "where a deal moves when a quotation is issued",
    whenAr: "حيث تنتقل الصفقة عند إصدار عرض سعر",
    unsetEn: "Not set — quotations are still issued, the card just does not move.",
    unsetAr: "غير مُهيَّأة — يُصدَر عرض السعر كالمعتاد، ولا تتحرّك بطاقة الصفقة.",
  },
  NEGOTIATION: {
    en: "Negotiation & approval",
    ar: "التفاوض والاعتماد",
    whenEn: "the deal page offers recording the negotiation result or the approval",
    whenAr: "تقترح صفحة الصفقة فيها تسجيل نتيجة التفاوض أو طلب الاعتماد",
    unsetEn: "Not set — the deal page falls back to «Next stage».",
    unsetAr: "غير مُهيَّأة — تقترح صفحة الصفقة «المرحلة التالية» فقط.",
  },
};

export default function SalesSettingsPage() {
  const lang = useLang();
  const ar = lang === "ar";
  const phone = usePhone();

  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Stage | null>(null);
  /**
   * What the server says this viewer may do (GET /api/sales/stages `can`). A rep without
   * sales › stage_manage reads the stages but cannot change them (POST/PATCH refuse), and
   * receives no team-wide deal counts: the screen is read-only for them and the open-deals
   * column is hidden rather than showing zeros. Until the answer arrives, nothing is offered.
   */
  const [can, setCan] = useState<{ manage: boolean; counts: boolean }>({ manage: false, counts: false });

  useD21Phone({ title: ar ? "إعدادات المبيعات" : "Sales settings", sub: ar ? "الإعدادات" : "Settings" });

  /**
   * Reload counter. The fetch lives in the effect; mutations bump this and the effect re-runs.
   * Same refresh, one owner of the fetch.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // `all=true`: retired stages must stay visible here, or there is no way to bring one back.
      const res = await api<{ stages: Stage[]; can?: { manage: boolean; counts: boolean } }>("/api/sales/stages?all=true");
      if (cancelled) return;
      if (res.ok) {
        setStages(res.data.stages);
        setCan({ manage: res.data.can?.manage === true, counts: res.data.can?.counts === true });
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ar, reloadToken]);

  // «حد الخصم الذي يحتاج اعتماد» (GET/PUT /api/settings/quotation). Empty = the built-in figure.
  const [disc, setDisc] = useState<{ stored: string | null; effective: string; canEdit: boolean } | null>(null);
  const [discInput, setDiscInput] = useState("");
  // «الحد الأدنى للتأهيل» (same endpoint, same admin gate): null until read.
  const [qualMin, setQualMin] = useState<boolean | null>(null);
  async function saveQualMin(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ requireQualificationMinimum: boolean; errorEn?: string }>(
      "/api/settings/quotation", { method: "PUT", body: { requireQualificationMinimum: next } },
    );
    setBusy(false);
    if (!res.ok) { setError((ar ? res.data.error : res.data.errorEn) ?? res.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save.")); return; }
    setQualMin(res.data.requireQualificationMinimum);
    setSuccess(res.data.requireQualificationMinimum
      ? (ar ? "لا يتحوّل العميل المحتمل إلى فرصة إلا بعد معرفة نوع النشاط والاحتياج والخطوة التالية." : "A lead now converts only once its business type, need and next step are known.")
      : (ar ? "عادت القاعدة السابقة: أي تفاعل مؤهِّل يحوّل العميل المحتمل." : "The legacy rule is back: any qualifying interaction converts the lead."));
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api<{ discountApprovalPercent: string | null; effectiveThresholdPercent: string; requireQualificationMinimum?: boolean; can: { edit: boolean } }>("/api/settings/quotation");
      if (cancelled || !res.ok) return;
      setDisc({ stored: res.data.discountApprovalPercent, effective: res.data.effectiveThresholdPercent, canEdit: res.data.can.edit });
      setQualMin(res.data.requireQualificationMinimum !== false);
      setDiscInput(res.data.discountApprovalPercent === null ? "" : String(Number(res.data.discountApprovalPercent)));
    })();
    return () => { cancelled = true; };
  }, [reloadToken]);
  async function saveThreshold() {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api<{ discountApprovalPercent: string | null; effectiveThresholdPercent: string; errorEn?: string }>(
      "/api/settings/quotation", { method: "PUT", body: { discountApprovalPercent: discInput.trim() } },
    );
    setBusy(false);
    if (!res.ok) { setError((ar ? res.data.error : res.data.errorEn) ?? res.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save.")); return; }
    setSuccess(res.data.discountApprovalPercent === null
      ? (ar ? `حدّ الخصم: الافتراضي (${res.data.effectiveThresholdPercent}%).` : `Discount threshold: the default (${res.data.effectiveThresholdPercent}%).`)
      : (ar ? `حدّ الخصم الذي يحتاج اعتماد: ${res.data.effectiveThresholdPercent}%.` : `Discount approval threshold: ${res.data.effectiveThresholdPercent}%.`));
    reload();
  }

  async function patch(changes: Partial<Stage> & { id: string }, okMessage: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await api("/api/sales/stages", { method: "PATCH", body: { stages: [changes] } });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.error ?? (ar ? "تعذّر الحفظ." : "Could not save."));
      return;
    }
    setSuccess(okMessage);
    reload();
  }

  /**
   * Swap two stages' positions. Both rows go in one request so the reorder is atomic: writing
   * them separately could leave two columns sharing a position if the second call failed.
   */
  async function move(index: number, direction: -1 | 1) {
    const ordered = [...stages].sort((a, b) => a.position - b.position);
    const target = ordered[index + direction];
    const self = ordered[index];
    if (!target || busy) return;

    setBusy(true);
    setError("");
    const res = await api("/api/sales/stages", {
      method: "PATCH",
      body: {
        stages: [
          { id: self.id, position: target.position },
          { id: target.id, position: self.position },
        ],
      },
    });
    setBusy(false);
    if (res.ok) reload();
    else setError(res.data.error ?? "");
  }

  if (loading) return <PerfLoading ar={ar} />;

  const ordered = [...stages].sort((a, b) => a.position - b.position);

  const purposeSelect = (s: Stage) => (
    // Saved on change rather than behind an Edit dialog: a single choice with an immediate
    // consequence, and the server takes the purpose off whichever column held it before.
    <span className="perf-selw">
      <Select
        id={`purpose-${s.id}`}
        className="perf-sel"
        value={s.purpose ?? ""}
        disabled={busy || !s.isActive || !can.manage}
        aria-label={ar ? `أتمتة مرحلة ${s.nameAr}` : `Automation for ${s.nameEn}`}
        onChange={(e) => {
          const v = e.target.value;
          patch(
            { id: s.id, purpose: (v || null) as StagePurpose | null },
            v
              ? ar
                ? `صارت هذه مرحلة ${PURPOSE_LABELS[v as StagePurpose].ar}.`
                : `This is now the ${PURPOSE_LABELS[v as StagePurpose].en} stage.`
              : ar
                ? "أُلغيت الأتمتة عن هذه المرحلة."
                : "Automation no longer points here.",
          );
        }}
      >
        <option value="">{ar ? "— لا شيء —" : "— none —"}</option>
        {(Object.keys(PURPOSE_LABELS) as StagePurpose[]).map((p) => (
          <option key={p} value={p}>{ar ? PURPOSE_LABELS[p].ar : PURPOSE_LABELS[p].en}</option>
        ))}
      </Select>
    </span>
  );

  const moveBtns = (s: Stage, i: number) => !can.manage ? null : (
    <span style={{ display: "inline-flex", gap: 2 }}>
      <button type="button" className="btn sm g" onClick={() => move(i, -1)} disabled={busy || i === 0}
        aria-label={ar ? `نقل ${s.nameAr} لأعلى` : `Move ${s.nameEn} up`}>↑</button>
      <button type="button" className="btn sm g" onClick={() => move(i, 1)} disabled={busy || i === ordered.length - 1}
        aria-label={ar ? `نقل ${s.nameAr} لأسفل` : `Move ${s.nameEn} down`}>↓</button>
    </span>
  );

  /**
   * Why «إخفاء» is unavailable, or null when it is not. The server refuses to retire a stage
   * that still holds OPEN deals (409); won and lost deals stay in a hidden stage and keep its
   * name (owner decision, batch Sales B). The button says so before anybody presses it.
   */
  const holdingReason = (s: Stage): string | null => {
    const count = s.openDeals ?? 0;
    if (count === 0) return null;
    return ar
      ? `لا تُخفى: فيها ${num(count, lang)} ${count === 1 ? "صفقة مفتوحة" : count === 2 ? "صفقتان مفتوحتان" : "صفقات مفتوحة"}. انقلها إلى مرحلة أخرى أولًا.`
      : `Cannot be retired: it holds ${count} open deal${count === 1 ? "" : "s"}. Move them to another stage first.`;
  };

  const rowBtns = (s: Stage) => {
    // Read-only viewers: no edit / hide / restore control at all, only the hidden marker.
    if (!can.manage) {
      return !s.isActive ? <span className="perf-rowbtns"><span className="perf-code">{ar ? "مخفية" : "retired"}</span></span> : null;
    }
    const reason = holdingReason(s);
    return (
    <span className="perf-rowbtns">
      <button type="button" className="btn sm" onClick={() => setEditing(s)} data-testid={`edit-stage-${s.code}`}>
        {ar ? "تعديل" : "Edit"}
      </button>
      {s.isActive ? (
        <span title={reason ?? undefined} style={{ display: "inline-flex" }}>
          <button type="button" className="btn sm" disabled={busy || reason !== null} data-testid={`retire-stage-${s.code}`}
            title={reason ?? undefined} aria-describedby={reason ? `retire-why-${s.id}` : undefined}
            onClick={() => patch({ id: s.id, isActive: false }, ar ? "أُخفيت المرحلة." : "Stage retired.")}>
            {ar ? "إخفاء" : "Retire"}
          </button>
          {reason && <span id={`retire-why-${s.id}`} className="sr-only" data-testid={`retire-why-${s.code}`}>{reason}</span>}
        </span>
      ) : (
        <button type="button" className="btn sm" disabled={busy} data-testid={`restore-stage-${s.code}`}
          onClick={() => patch({ id: s.id, isActive: true }, ar ? "أُعيدت المرحلة." : "Stage restored.")}>
          {ar ? "إظهار" : "Restore"}
        </button>
      )}
      {!s.isActive && <span className="perf-code">{ar ? "مخفية" : "retired"}</span>}
    </span>
    );
  };

  const newStage = !can.manage ? null : (
    <button type="button" className="btn p" onClick={() => setAdding(true)} data-testid="new-stage">
      <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
      {ar ? "مرحلة جديدة" : "New stage"}
    </button>
  );

  const stagesBlock = ordered.length === 0 ? (
    <div style={{ padding: "36px 0", textAlign: "center" }} data-testid="stages-empty">
      <p style={{ fontWeight: 500, margin: 0 }}>
        {ar ? "لا توجد مراحل. أضف واحدة على الأقل، وإلا فلا يمكن تحويل عميل محتمل إلى صفقة." : "No stages. Add at least one, or a lead cannot be converted into a deal."}
      </p>
    </div>
  ) : phone ? (
    <div data-testid="stages-table">
      {ordered.map((s, i) => (
        <div key={s.id} className="mrow" style={s.isActive ? undefined : { opacity: 0.7 }} data-testid={`stage-row-${s.code}`}>
          <div style={{ minWidth: 0 }}>
            <span className="who">{ar ? s.nameAr : s.nameEn}</span>{" "}
            <span className="id">{s.code}</span>
          </div>
          {moveBtns(s, i)}
          <div className="r2">
            <span style={{ flex: 1 }}>
              {ar ? "الاحتمال" : "Probability"} <span className="n">{s.probability}%</span>
              {can.counts && <> · {ar ? "صفقات مفتوحة" : "Open deals"} <span className="n">{num(s.openDeals ?? 0, lang)}</span></>}
            </span>
          </div>
          <div className="r2" style={{ marginTop: 6, flexWrap: "wrap" }}>{purposeSelect(s)}{rowBtns(s)}</div>
          {can.manage && s.isActive && holdingReason(s) && <div className="r2" aria-hidden>{holdingReason(s)}</div>}
        </div>
      ))}
    </div>
  ) : (
    <div className="perf-scroll">
      <table className="t" data-testid="stages-table">
        <thead><tr>
          {can.manage && <th scope="col">{ar ? "الترتيب" : "Order"}</th>}
          <th scope="col">{ar ? "الرمز" : "Code"}</th>
          <th scope="col">{ar ? "الاسم" : "Name"}</th>
          <th scope="col" className="num">{ar ? "الاحتمال" : "Probability"}</th>
          <th scope="col">{ar ? "الأتمتة" : "Automation"}</th>
          {can.counts && <th scope="col" className="num">{ar ? "الصفقات المفتوحة" : "Open deals"}</th>}
          {can.manage && <th scope="col"><span className="sr-only">{ar ? "الإجراءات" : "Actions"}</span></th>}
        </tr></thead>
        <tbody>
          {ordered.map((s, i) => (
            <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.7 }} data-testid={`stage-row-${s.code}`}>
              {can.manage && <td>{moveBtns(s, i)}</td>}
              {/* The stable identity. Shown, and never editable. */}
              <td className="id">{s.code}</td>
              <td style={{ paddingBlock: 4 }}>
                <div className="who">{ar ? s.nameAr : s.nameEn}</div>
                <span className="perf-sub">{ar ? s.nameEn : s.nameAr}</span>
                {/* Read-only viewers have no actions column; a retired stage is still marked. */}
                {!can.manage && !s.isActive && <span className="perf-code" style={{ marginInlineStart: 6 }}>{ar ? "مخفية" : "retired"}</span>}
              </td>
              <td className="num"><span className="n">{s.probability}%</span></td>
              <td>{purposeSelect(s)}</td>
              {can.counts && (
                <td className="num" title={ar ? `كل الصفقات: ${num(s._count?.opportunities ?? 0, lang)}` : `All deals: ${s._count?.opportunities ?? 0}`}>
                  <span className="n">{num(s.openDeals ?? 0, lang)}</span>
                </td>
              )}
              {can.manage && <td style={{ textAlign: "end" }}>{rowBtns(s)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="perf-settings">
    {!phone && <SettingsNav />}
    <div className="pg">
      {phone ? (
        <div className="perf-ph">
          <div className="perf-ph-act">{newStage}</div>
          <div className="perf-ph-meta">{ar ? "تغيير المراحل يغيّر سلوك الشاشات فورًا" : "Changing stages changes the screens at once"}</div>
        </div>
      ) : (
        <div className="ph" style={{ marginBottom: 20 }}>
          <div>
            <h1>{ar ? "المبيعات" : "Sales"}</h1>
            <div className="meta">
              <span>{ar ? "المراحل والمصادر وحدود الخصم — تغييرها يغيّر سلوك الشاشات فورًا" : "Stages, sources and discount limits — changing these changes the screens at once"}</span>
            </div>
          </div>
          <div className="act">{newStage}</div>
        </div>
      )}

      <PerfNotice kind="error" ar={ar} onDismiss={() => setError("")}>{error}</PerfNotice>
      <PerfNotice kind="success" ar={ar} onDismiss={() => setSuccess("")}>{success}</PerfNotice>

      <div className="bh">
        <h2 className="bt">{ar ? "مراحل مسار الصفقات" : "Pipeline stages"}</h2>
        <span className="sub">{ar ? "تُخفى ولا تُحذف · لا تُخفى مرحلة فيها صفقات مفتوحة" : "retired, never deleted · a stage holding open deals cannot be retired"}</span>
      </div>
      {!can.manage && (
        <div style={{ marginBottom: 12 }}>
          <PerfNote testId="stages-readonly">
            {ar
              ? "للعرض فقط: تعديل المراحل وترتيبها وإخفاؤها لمن لديه صلاحية «ضبط مراحل الصفقات»."
              : "Read only: editing, reordering and retiring stages needs the «Configure pipeline stages» permission."}
          </PerfNote>
        </div>
      )}
      {stagesBlock}

      {/* What the Automation column actually controls, and what happens when it is unset. */}
      <div style={{ marginTop: 12 }}>
        <PerfNote>
          <div>
            <b style={{ fontWeight: 600 }}>{ar ? "الأتمتة:" : "Automation:"}</b>
            <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
              {(Object.keys(PURPOSE_LABELS) as StagePurpose[]).map((p) => {
                const held = stages.find((s) => s.purpose === p);
                return (
                  <li key={p}>
                    «{ar ? PURPOSE_LABELS[p].ar : PURPOSE_LABELS[p].en}» — {ar ? PURPOSE_LABELS[p].whenAr : PURPOSE_LABELS[p].whenEn}.{" "}
                    {held ? (
                      <span style={{ color: "var(--status-success)" }}>
                        {ar ? `المرحلة الحالية: ${held.nameAr}` : `Currently: ${held.nameEn}`}
                      </span>
                    ) : (
                      <span style={{ color: "var(--status-warning)" }}>
                        {ar ? PURPOSE_LABELS[p].unsetAr : PURPOSE_LABELS[p].unsetEn}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            <span style={{ display: "block", marginTop: 4, color: "var(--text-muted)", fontSize: 12.5 }}>
              {ar ? "كل غرض لمرحلة واحدة. المرحلة تُخفى ولا تُحذف: كل حركة سُجّلت تشير إليها." : "Each purpose belongs to one stage. A stage is retired, never deleted: every stage event that mentioned it points here."}
            </span>
          </div>
        </PerfNote>
      </div>

      {/* «الحد الأدنى للتأهيل»: what makes an interested lead a qualified opportunity. */}
      {qualMin !== null && (
        <div style={{ marginTop: 12 }} data-testid="qualification-minimum">
          <PerfNote>
            <div>
              <b style={{ fontWeight: 600 }}>{ar ? "الحد الأدنى للتأهيل:" : "Qualification minimum:"}</b>{" "}
              {qualMin
                ? (ar ? "مفعّل — يتحوّل العميل المحتمل إلى فرصة مؤهلة عند معرفة نوع النشاط والاحتياج والخطوة التالية المتفق عليها (الكمية اختيارية)." : "On — a lead becomes a qualified opportunity once its business type, need and agreed next step are known (volume optional).")
                : (ar ? "غير مفعّل — أي تفاعل مؤهِّل (مهتم، موعد، زيارة) يحوّل العميل المحتمل كما في السابق." : "Off — any qualifying interaction (interested, a meeting, a visit) converts the lead, as before.")}
              {disc?.canEdit && (
                <button type="button" className="btn sm" style={{ marginInlineStart: 8 }} disabled={busy}
                  data-testid="qualification-minimum-toggle" onClick={() => saveQualMin(!qualMin)}>
                  {qualMin ? (ar ? "إيقاف" : "Turn off") : (ar ? "تفعيل" : "Turn on")}
                </button>
              )}
            </div>
          </PerfNote>
        </div>
      )}

      <div className="hr" style={{ margin: "28px 0" }} />

      {/* Read-only: the seven stored lead sources. The discount threshold is a setting
          (Settings › quotations; the admin role edits it), the 60% ceiling is policy in code. */}
      <div className="cols perf-cols" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 40 }}>
        <div>
          <div className="bh">
            <h2 className="bt">{ar ? "مصادر العملاء المحتملين" : "Lead sources"}</h2>
            <span className="sub">{ar ? "ثابتة في النظام · للعرض" : "fixed in the system · for reference"}</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="source-chips">
            {Object.entries(LEAD_SOURCE_LABELS).map(([code, l]) => (
              <span key={code} className="chip">{ar ? l.ar : l.en}</span>
            ))}
          </div>
        </div>
        <div>
          <div className="bh">
            <h2 className="bt">{ar ? "حدود الخصم والصلاحيات" : "Discount limits"}</h2>
            <span className="sub">{disc?.canEdit ? (ar ? "الحد قابل للتعديل · السقف ثابت" : "the threshold is editable · the ceiling is fixed") : (ar ? "للعرض" : "for reference")}</span>
          </div>
          {disc?.canEdit && (
            <div className="tool" style={{ alignItems: "flex-end", marginBottom: 14 }} data-testid="discount-threshold-form">
              <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
                <span>{ar ? "حد الخصم الذي يحتاج اعتماد (%)" : "Discount that needs approval, above (%)"}</span>
                <input className="q-set-input" inputMode="decimal" value={discInput} onChange={(e) => setDiscInput(e.target.value)}
                  placeholder={ar ? `فارغ = الافتراضي ${DISCOUNT_APPROVAL_THRESHOLD}` : `empty = default ${DISCOUNT_APPROVAL_THRESHOLD}`}
                  aria-describedby="disc-help" data-testid="discount-threshold-input" />
              </label>
              <button type="button" className="btn p" disabled={busy} onClick={saveThreshold} data-testid="discount-threshold-save">{ar ? "حفظ" : "Save"}</button>
              <span id="disc-help" className="sm" style={{ flexBasis: "100%", fontSize: 12.5, color: "var(--text-muted)" }}>
                {ar ? `من 0 إلى ${DISCOUNT_MAX}. فوقه يحتاج الإصدار اعتماد مدير لديه صلاحية اعتماد الخصم. فارغ = ${DISCOUNT_APPROVAL_THRESHOLD}% كما هو الآن.` : `0 to ${DISCOUNT_MAX}. Above it, issuing needs a manager with discount approval. Empty = ${DISCOUNT_APPROVAL_THRESHOLD}%, as today.`}
              </span>
            </div>
          )}
          <dl className="props" style={{ gridTemplateColumns: "140px minmax(0,1fr)" }} data-testid="discount-limits">
            <dt>{ar ? "بلا اعتماد" : "Without approval"}</dt>
            <dd>
              {(() => { const t = Number(disc?.effective ?? DISCOUNT_APPROVAL_THRESHOLD); return ar ? `حتى ${num(t, "ar")}%` : `up to ${t}%`; })()}
              {disc && disc.stored === null && <span className="sm" style={{ color: "var(--text-muted)" }}>{ar ? " · الافتراضي" : " · default"}</span>}
            </dd>
            <dt>{ar ? "باعتماد الخصم" : "With discount approval"}</dt>
            <dd>{ar ? `حتى ${num(DISCOUNT_MAX, "ar")}%` : `up to ${DISCOUNT_MAX}%`}</dd>
            <dt>{ar ? "فوق ذلك" : "Above that"}</dt>
            <dd>{ar ? "مرفوض" : "refused"}</dd>
          </dl>
          <p className="sm" style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
            {ar ? "تجاوز الحدّ يُعلِّم العرض «يحتاج اعتماد خصم» في القائمة، ويعتمده المدير أو يرفضه قبل الإصدار." : "Past the threshold the quotation is flagged «needs discount approval»; a manager approves or refuses it before it is issued."}
          </p>
        </div>
      </div>

      {(adding || editing) && (
        <StageDialog
          ar={ar}
          stage={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onDone={(m) => {
            setAdding(false);
            setEditing(null);
            setSuccess(m);
            reload();
          }}
        />
      )}
    </div>
    </div>
  );
}

function StageDialog({
  ar, stage, onClose, onDone,
}: {
  ar: boolean;
  stage: Stage | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [code, setCode] = useState(stage?.code ?? "");
  const [nameEn, setNameEn] = useState(stage?.nameEn ?? "");
  const [nameAr, setNameAr] = useState(stage?.nameAr ?? "");
  const [probability, setProbability] = useState(String(stage?.probability ?? 0));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const valid =
    nameEn.trim().length >= 2 &&
    nameAr.trim().length >= 2 &&
    (stage !== null || /^[A-Za-z0-9_]{2,32}$/.test(code.trim()));

  return (
    <Modal
      title={stage ? (ar ? "تعديل المرحلة" : "Edit the stage") : ar ? "مرحلة جديدة" : "New stage"}
      onClose={onClose}
      testId="stage-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{ar ? "إلغاء" : "Cancel"}</Button>
          <Button
            disabled={busy || !valid}
            testId="save-stage"
            onClick={async () => {
              setBusy(true);
              setErr("");
              const res = stage
                ? await api("/api/sales/stages", {
                    method: "PATCH",
                    body: {
                      stages: [
                        { id: stage.id, nameEn, nameAr, probability: Number(probability) },
                      ],
                    },
                  })
                : await api("/api/sales/stages", {
                    method: "POST",
                    body: { code: code.trim().toUpperCase(), nameEn, nameAr, probability: Number(probability) },
                  });
              setBusy(false);
              if (res.ok) {
                onDone(stage ? (ar ? "حُفظت المرحلة." : "Stage saved.") : ar ? "أُضيفت المرحلة." : "Stage added.");
              } else {
                setErr(res.data.error ?? "");
              }
            }}
          >
            {ar ? "حفظ" : "Save"}
          </Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}

      {stage ? (
        <Field
          id="st-code"
          label={ar ? "الرمز" : "Code"}
          hint={
            ar
              ? "الهوية الثابتة للمرحلة. لا تتغيّر — الاسم قابل للترجمة، والرمز ليس كذلك."
              : "The stage's stable identity. It does not change: the label is translatable, the code is not."
          }
        >
          <TextInput id="st-code" value={stage.code} onChange={() => {}} disabled />
        </Field>
      ) : (
        <Field
          id="st-code"
          label={ar ? "الرمز" : "Code"}
          required
          hint="QUALIFY, PROPOSAL, NEGOTIATION…"
        >
          <TextInput id="st-code" value={code} onChange={setCode} />
        </Field>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <Field id="st-en" label={ar ? "الاسم بالإنجليزية" : "English name"} required>
          <TextInput id="st-en" value={nameEn} onChange={setNameEn} />
        </Field>
        <Field id="st-ar" label={ar ? "الاسم بالعربية" : "Arabic name"} required>
          <TextInput id="st-ar" value={nameAr} onChange={setNameAr} />
        </Field>
      </div>

      <Field
        id="st-prob"
        label={ar ? "الاحتمال %" : "Probability %"}
        hint={
          ar
            ? "استرشادي فقط: يُقترح على الصفقة عند دخولها المرحلة، ولا يُحسب منه شيء."
            : "Advisory only: offered to a deal entering this stage. Nothing is computed from it."
        }
      >
        <TextInput id="st-prob" value={probability} onChange={setProbability} inputMode="numeric" />
      </Field>

      <p className="text-[11px] text-oo-text-muted font-medium">
        {ar
          ? "كلا الاسمين مطلوبان. مرحلة بالإنجليزية فقط تظهر كفراغ على اللوحة التي يعمل عليها معظم المستخدمين."
          : "Both names are required. A stage with only an English label renders as a gap on the board most of these users actually work in."}
      </p>
    </Modal>
  );
}
