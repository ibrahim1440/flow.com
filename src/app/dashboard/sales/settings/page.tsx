"use client";

import { useState, useEffect } from "react";
import { KanbanSquare, Plus, ArrowUp, ArrowDown, EyeOff, Eye } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState, Spinner,
  Button, Field, TextInput, Pill, Modal, api, Td, ROW_ACTION, num, LEAD_SOURCE_LABELS,
} from "../_components/ui";
import { DISCOUNT_APPROVAL_THRESHOLD, DISCOUNT_MAX } from "@/lib/services/sales/discount-limits";

/**
 * Pipeline configuration.
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
 * PROVISIONAL INTERFACE — see the banner.
 */

type Stage = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  position: number;
  probability: number;
  isActive: boolean;
  _count?: { opportunities: number };
};

export default function SalesSettingsPage() {
  const lang = useLang();
  const ar = lang === "ar";

  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Stage | null>(null);

  /**
   * Reload counter.
   *
   * The fetch lives in the effect instead of a `useCallback` the effect calls, because the
   * lint rule resolves a called callback and sees setState reachable from the effect body.
   * Mutations still need to refresh, so instead of holding a callable loader they bump this
   * and the effect re-runs. Same refresh, one owner of the fetch.
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
   * Swap two stages' positions.
   *
   * Both rows go in one request so the reorder is atomic: writing them separately could
   * leave two columns sharing a position if the second call failed.
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

  if (loading) return <Spinner />;

  const ordered = [...stages].sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-[18px]">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "إعدادات المبيعات" : "Sales settings"}
        subtitle={
          <span>
            {ar
              ? "المراحل والمصادر وحدود الخصم — تغييرها يغيّر سلوك الشاشات فوراً"
              : "Stages, sources and discount limits — changing these changes the screens at once"}
          </span>
        }
        actions={
          <Button onClick={() => setAdding(true)} testId="new-stage">
            <Plus size={15} aria-hidden /> {ar ? "مرحلة جديدة" : "New stage"}
          </Button>
        }
      />

      {error && <Alert kind="error" onDismiss={() => setError("")}>{error}</Alert>}
      {success && <Alert kind="success" onDismiss={() => setSuccess("")}>{success}</Alert>}

      <Card>
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <KanbanSquare size={14} aria-hidden /> {ar ? "مراحل مسار الصفقات" : "Pipeline stages"}
          </span>
        </SectionTitle>

        {ordered.length === 0 ? (
          <EmptyState>
            {ar
              ? "لا توجد مراحل. أضف واحدة على الأقل، وإلا فلا يمكن تحويل عميل محتمل إلى صفقة."
              : "No stages. Add at least one, or a lead cannot be converted into a deal."}
          </EmptyState>
        ) : (
          // Flush to the card's edges, so the tinted header band reads as part of the card
          // rather than as a second box floating inside it.
          <div className="-mx-5 mt-3 overflow-x-auto border-y border-oo-border-default">
            <table className="w-full min-w-[760px] border-collapse text-start" data-testid="stages-table">
              <thead>
                <tr className="bg-oo-bg-subtle">
                  {[
                    [ar ? "الترتيب" : "Order", "w-[90px]"],
                    [ar ? "الرمز" : "Code", "w-[140px]"],
                    [ar ? "الاسم" : "Name", "min-w-[200px]"],
                    [ar ? "الاحتمال الافتراضي" : "Default probability", "w-[170px]"],
                    [ar ? "الصفقات" : "Deals", "w-[100px]"],
                    ["", "w-[200px]"],
                  ].map(([l, w], i) => (
                    <th
                      key={i}
                      scope="col"
                      className={`${w} px-4 py-[11px] text-start text-[12px] font-medium leading-[18px] text-oo-text-muted`}
                    >
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ordered.map((s, i) => (
                  <tr
                    key={s.id}
                    className={`border-t border-oo-border-default ${s.isActive ? "" : "opacity-50"}`}
                    data-testid={`stage-row-${s.code}`}
                  >
                    <Td>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => move(i, -1)}
                          disabled={busy || i === 0}
                          aria-label={ar ? `نقل ${s.nameAr} لأعلى` : `Move ${s.nameEn} up`}
                          className="rounded p-1 text-oo-text-muted hover:text-oo-action-primary disabled:opacity-30"
                        >
                          <ArrowUp size={14} aria-hidden />
                        </button>
                        <button
                          onClick={() => move(i, 1)}
                          disabled={busy || i === ordered.length - 1}
                          aria-label={ar ? `نقل ${s.nameAr} لأسفل` : `Move ${s.nameEn} down`}
                          className="rounded p-1 text-oo-text-muted hover:text-oo-action-primary disabled:opacity-30"
                        >
                          <ArrowDown size={14} aria-hidden />
                        </button>
                      </div>
                    </Td>
                    <Td>
                      {/* The stable identity. Shown, and never editable: the label may be
                          translated, this may not change. */}
                      <span className="rounded-md bg-oo-bg-subtle px-1.5 py-0.5 font-mono text-[12px] leading-[18px] text-oo-text-secondary">
                        {s.code}
                      </span>
                    </Td>
                    <Td>
                      <span className="block font-medium">{ar ? s.nameAr : s.nameEn}</span>
                      <span className="block text-[12px] leading-[18px] text-oo-text-muted">
                        {ar ? s.nameEn : s.nameAr}
                      </span>
                    </Td>
                    <Td>{ar ? `${num(s.probability, "ar")}%` : `${s.probability}%`}</Td>
                    <Td>{num(s._count?.opportunities ?? 0, lang)}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          onClick={() => setEditing(s)}
                          data-testid={`edit-stage-${s.code}`}
                          className={`${ROW_ACTION} text-oo-action-primary hover:border-oo-action-primary`}
                        >
                          {ar ? "تعديل" : "Edit"}
                        </button>
                        {s.isActive ? (
                          <button
                            disabled={busy}
                            data-testid={`retire-stage-${s.code}`}
                            title={
                              (s._count?.opportunities ?? 0) > 0
                                ? ar
                                  ? "انقل الصفقات أولاً"
                                  : "Move its deals first"
                                : undefined
                            }
                            onClick={() =>
                              patch(
                                { id: s.id, isActive: false },
                                ar ? "أُخفيت المرحلة." : "Stage retired.",
                              )
                            }
                            className={`${ROW_ACTION} gap-1.5 text-oo-text-secondary hover:border-oo-action-primary disabled:opacity-50`}
                          >
                            <EyeOff size={14} aria-hidden /> {ar ? "إخفاء" : "Retire"}
                          </button>
                        ) : (
                          <button
                            disabled={busy}
                            data-testid={`restore-stage-${s.code}`}
                            onClick={() =>
                              patch(
                                { id: s.id, isActive: true },
                                ar ? "أُعيدت المرحلة." : "Stage restored.",
                              )
                            }
                            className={`${ROW_ACTION} gap-1.5 text-oo-text-secondary hover:border-oo-action-primary disabled:opacity-50`}
                          >
                            <Eye size={14} aria-hidden /> {ar ? "إظهار" : "Restore"}
                          </button>
                        )}
                        {!s.isActive && <Pill tone="neutral">{ar ? "مخفية" : "retired"}</Pill>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-[12px] leading-[18px] text-oo-text-muted">
          {ar
            ? "المرحلة تُخفى ولا تُحذف: كل حركة سُجّلت في السجل تشير إليها، وحذفها يكسر التاريخ الذي وُجدت تلك الحركات لحفظه. ومرحلة بها صفقات لا يمكن إخفاؤها — انقل صفقاتها أولاً."
            : "A stage is retired, never deleted: every stage event that ever mentioned it points here, and deleting it would break the history those events exist to preserve. A stage holding deals cannot be retired — move them first."}
        </p>
      </Card>

      {/* ── The two reference cards the design puts beside the stages ────────────────
          Read-only on purpose. Both state values the rest of the module already enforces:
          the seven stored lead sources, and the two discount limits the quotation service
          applies. Neither is editable here, because neither is a settings row — changing
          them is a code change, and a screen that implied otherwise would be lying. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>{ar ? "مصادر العملاء المحتملين" : "Lead sources"}</SectionTitle>
          <p className="-mt-1 mb-3 text-[12px] leading-[18px] text-oo-text-secondary">
            {ar
              ? "القيَم المخزَّنة السبع — تظهر في مرشّح القائمة ونموذج الإنشاء"
              : "The seven stored values — they appear in the list filter and the create form"}
          </p>
          <div className="flex flex-wrap gap-2" data-testid="source-chips">
            {Object.entries(LEAD_SOURCE_LABELS).map(([code, l]) => (
              <span
                key={code}
                className="rounded-[10px] border border-oo-border-strong bg-oo-bg-subtle px-3 py-[5px] text-[12px] leading-[18px] text-oo-text-primary"
              >
                {ar ? l.ar : l.en}
              </span>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle>{ar ? "حدود الخصم والصلاحيات" : "Discount limits"}</SectionTitle>
          <p className="-mt-1 mb-3 text-[12px] leading-[18px] text-oo-text-secondary">
            {ar
              ? "تجاوز الحدّ يحوّل «إصدار العرض» إلى «طلب اعتماد الخصم»"
              : "Past the threshold, “Issue” becomes “Ask for discount approval”"}
          </p>
          <div className="space-y-2" data-testid="discount-limits">
            {[
              [
                ar ? "بلا اعتماد" : "Without approval",
                ar ? `حتى ${num(DISCOUNT_APPROVAL_THRESHOLD, "ar")}%` : `up to ${DISCOUNT_APPROVAL_THRESHOLD}%`,
              ],
              [
                ar ? "باعتماد الخصم" : "With the discount-approval privilege",
                ar ? `حتى ${num(DISCOUNT_MAX, "ar")}%` : `up to ${DISCOUNT_MAX}%`,
              ],
              [ar ? "فوق ذلك" : "Above that", ar ? "مرفوض" : "refused"],
            ].map(([who, limit]) => (
              <div
                key={who}
                className="flex items-center justify-between rounded-[10px] bg-oo-bg-subtle px-3 py-[9px] text-[14px] leading-[22px] text-oo-text-primary"
              >
                <span className="font-medium">{limit}</span>
                <span>{who}</span>
              </div>
            ))}
          </div>
        </Card>
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
