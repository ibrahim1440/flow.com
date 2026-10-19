"use client";

import { useState, useEffect } from "react";
import {
  useLang, Button, Field, TextInput, Modal, Alert, api, num, LEAD_SOURCE_LABELS,
} from "../_components/ui";
import { PerfNotice, PerfLoading, PerfNote } from "../_components/perf";
import { usePhone, useD21Phone } from "@/components/shell/page-context";
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
 * The frame's settings navigation column (المنشأة, المستخدمون…) is not built — see the report.
 */

type StagePurpose = "QUALIFICATION" | "QUOTATION";

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
};

/**
 * The two moments the server makes by itself, and where each one puts the deal.
 *
 * Deliberately not matched against the stage's code or its name: the names are translated
 * and editable, and this deployment's codes are historical (`UAT_QUALIFY`, `UAT_PROPOSAL`).
 * Somebody has to say which column is which, once, here.
 */
const PURPOSE_LABELS: Record<StagePurpose, { en: string; ar: string; whenEn: string; whenAr: string }> = {
  QUALIFICATION: {
    en: "Qualification",
    ar: "التأهيل",
    whenEn: "where a lead lands when an interaction qualifies it",
    whenAr: "حيث يصل العميل المحتمل عندما يؤهّله تفاعل",
  },
  QUOTATION: {
    en: "Quotation",
    ar: "عرض السعر",
    whenEn: "where a deal moves when a quotation is issued",
    whenAr: "حيث تنتقل الصفقة عند إصدار عرض سعر",
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
      const res = await api<{ stages: Stage[] }>("/api/sales/stages?all=true");
      if (cancelled) return;
      if (res.ok) {
        setStages(res.data.stages);
        setError("");
      } else {
        setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ar, reloadToken]);

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
      <select
        id={`purpose-${s.id}`}
        className="perf-sel"
        value={s.purpose ?? ""}
        disabled={busy || !s.isActive}
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
      </select>
      <svg className="ico s" viewBox="0 0 24 24" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
    </span>
  );

  const moveBtns = (s: Stage, i: number) => (
    <span style={{ display: "inline-flex", gap: 2 }}>
      <button type="button" className="btn sm g" onClick={() => move(i, -1)} disabled={busy || i === 0}
        aria-label={ar ? `نقل ${s.nameAr} لأعلى` : `Move ${s.nameEn} up`}>↑</button>
      <button type="button" className="btn sm g" onClick={() => move(i, 1)} disabled={busy || i === ordered.length - 1}
        aria-label={ar ? `نقل ${s.nameAr} لأسفل` : `Move ${s.nameEn} down`}>↓</button>
    </span>
  );

  const rowBtns = (s: Stage) => (
    <span className="perf-rowbtns">
      <button type="button" className="btn sm" onClick={() => setEditing(s)} data-testid={`edit-stage-${s.code}`}>
        {ar ? "تعديل" : "Edit"}
      </button>
      {s.isActive ? (
        <button type="button" className="btn sm" disabled={busy} data-testid={`retire-stage-${s.code}`}
          title={(s._count?.opportunities ?? 0) > 0 ? (ar ? "انقل الصفقات أولًا" : "Move its deals first") : undefined}
          onClick={() => patch({ id: s.id, isActive: false }, ar ? "أُخفيت المرحلة." : "Stage retired.")}>
          {ar ? "إخفاء" : "Retire"}
        </button>
      ) : (
        <button type="button" className="btn sm" disabled={busy} data-testid={`restore-stage-${s.code}`}
          onClick={() => patch({ id: s.id, isActive: true }, ar ? "أُعيدت المرحلة." : "Stage restored.")}>
          {ar ? "إظهار" : "Restore"}
        </button>
      )}
      {!s.isActive && <span className="perf-code">{ar ? "مخفية" : "retired"}</span>}
    </span>
  );

  const newStage = (
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
              {ar ? "الاحتمال" : "Probability"} <span className="n">{s.probability}%</span> · {ar ? "الصفقات" : "Deals"} <span className="n">{num(s._count?.opportunities ?? 0, lang)}</span>
            </span>
          </div>
          <div className="r2" style={{ marginTop: 6, flexWrap: "wrap" }}>{purposeSelect(s)}{rowBtns(s)}</div>
        </div>
      ))}
    </div>
  ) : (
    <div className="perf-scroll">
      <table className="t" data-testid="stages-table">
        <thead><tr>
          <th scope="col">{ar ? "الترتيب" : "Order"}</th>
          <th scope="col">{ar ? "الرمز" : "Code"}</th>
          <th scope="col">{ar ? "الاسم" : "Name"}</th>
          <th scope="col" className="num">{ar ? "الاحتمال" : "Probability"}</th>
          <th scope="col">{ar ? "الأتمتة" : "Automation"}</th>
          <th scope="col" className="num">{ar ? "الصفقات" : "Deals"}</th>
          <th scope="col"><span className="sr-only">{ar ? "الإجراءات" : "Actions"}</span></th>
        </tr></thead>
        <tbody>
          {ordered.map((s, i) => (
            <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.7 }} data-testid={`stage-row-${s.code}`}>
              <td>{moveBtns(s, i)}</td>
              {/* The stable identity. Shown, and never editable. */}
              <td className="id">{s.code}</td>
              <td style={{ paddingBlock: 4 }}>
                <div className="who">{ar ? s.nameAr : s.nameEn}</div>
                <span className="perf-sub">{ar ? s.nameEn : s.nameAr}</span>
              </td>
              <td className="num"><span className="n">{s.probability}%</span></td>
              <td>{purposeSelect(s)}</td>
              <td className="num"><span className="n">{num(s._count?.opportunities ?? 0, lang)}</span></td>
              <td style={{ textAlign: "end" }}>{rowBtns(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="pg">
      {phone ? (
        <div className="perf-ph">
          <div className="perf-ph-act">{newStage}</div>
          <div className="perf-ph-meta">{ar ? "تغيير المراحل يغيّر سلوك الشاشات فورًا" : "Changing stages changes the screens at once"}</div>
        </div>
      ) : (
        <div className="ph" style={{ marginBottom: 20 }}>
          <div>
            <h1>{ar ? "إعدادات المبيعات" : "Sales settings"}</h1>
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
        <span className="sub">{ar ? "تُخفى ولا تُحذف · لا تُخفى مرحلة فيها صفقات" : "retired, never deleted · a stage holding deals cannot be retired"}</span>
      </div>
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
                        {p === "QUALIFICATION"
                          ? ar ? "غير مُهيَّأة — لن يتحوّل أي عميل محتمل تلقائيًا حتى تُحدَّد مرحلة." : "Not set — no lead will qualify automatically until a stage is chosen."
                          : ar ? "غير مُهيَّأة — يُصدَر عرض السعر كالمعتاد، ولا تتحرّك بطاقة الصفقة." : "Not set — quotations are still issued, the card just does not move."}
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

      <div className="hr" style={{ margin: "28px 0" }} />

      {/* Read-only on purpose: the seven stored lead sources, and the discount limits the
          quotation service applies. Neither is a settings row — changing them is a code change. */}
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
            <span className="sub">{ar ? "ثابتة في النظام · للعرض" : "fixed in the system · for reference"}</span>
          </div>
          <dl className="props" style={{ gridTemplateColumns: "140px minmax(0,1fr)" }} data-testid="discount-limits">
            <dt>{ar ? "بلا اعتماد" : "Without approval"}</dt>
            <dd>{ar ? `حتى ${num(DISCOUNT_APPROVAL_THRESHOLD, "ar")}%` : `up to ${DISCOUNT_APPROVAL_THRESHOLD}%`}</dd>
            <dt>{ar ? "باعتماد الخصم" : "With discount approval"}</dt>
            <dd>{ar ? `حتى ${num(DISCOUNT_MAX, "ar")}%` : `up to ${DISCOUNT_MAX}%`}</dd>
            <dt>{ar ? "فوق ذلك" : "Above that"}</dt>
            <dd>{ar ? "مرفوض" : "refused"}</dd>
          </dl>
          <p className="sm" style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
            {ar ? "تجاوز الحدّ يحوّل «إصدار العرض» إلى «طلب اعتماد الخصم»." : "Past the threshold, “Issue” becomes “Ask for discount approval”."}
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
