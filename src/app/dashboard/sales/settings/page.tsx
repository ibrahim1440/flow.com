"use client";

import { useState, useEffect, useCallback } from "react";
import { KanbanSquare, Plus, ArrowUp, ArrowDown, EyeOff, Eye } from "lucide-react";
import {
  useLang, ProvisionalBanner, PageHeader, Alert, Card, SectionTitle, EmptyState, Spinner,
  Button, Field, TextInput, Pill, Modal, TableWrap, api,
} from "../_components/ui";

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

  const load = useCallback(async () => {
    // `all=true`: retired stages must stay visible here, or there is no way to bring one back.
    const res = await api<{ stages: Stage[] }>("/api/sales/stages?all=true");
    if (res.ok) {
      setStages(res.data.stages);
      setError("");
    } else {
      setError(res.data.error ?? (ar ? "تعذّر التحميل." : "Could not load."));
    }
    setLoading(false);
  }, [ar]);

  useEffect(() => {
    load();
  }, [load]);

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
    load();
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
    if (res.ok) load();
    else setError(res.data.error ?? "");
  }

  if (loading) return <Spinner />;

  const ordered = [...stages].sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-6">
      <ProvisionalBanner />

      <PageHeader
        title={ar ? "إعدادات المبيعات" : "Sales settings"}
        subtitle={
          <span className="mt-1 block">
            {ordered.filter((s) => s.isActive).length} {ar ? "مرحلة نشطة" : "active stages"}
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
          <TableWrap>
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-[11px] uppercase text-brown/60 font-bold">
                  <th className="text-start py-2">{ar ? "الترتيب" : "Order"}</th>
                  <th className="text-start py-2">{ar ? "الرمز" : "Code"}</th>
                  <th className="text-start py-2">{ar ? "الاسم" : "Name"}</th>
                  <th className="text-end py-2">{ar ? "الاحتمال" : "Probability"}</th>
                  <th className="text-end py-2">{ar ? "الصفقات" : "Deals"}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {ordered.map((s, i) => (
                  <tr
                    key={s.id}
                    className={`border-t border-border ${s.isActive ? "" : "opacity-50"}`}
                    data-testid={`stage-row-${s.code}`}
                  >
                    <td className="py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => move(i, -1)}
                          disabled={busy || i === 0}
                          aria-label={ar ? `نقل ${s.nameAr} لأعلى` : `Move ${s.nameEn} up`}
                          className="p-1 rounded text-brown/60 hover:text-orange disabled:opacity-30"
                        >
                          <ArrowUp size={14} aria-hidden />
                        </button>
                        <button
                          onClick={() => move(i, 1)}
                          disabled={busy || i === ordered.length - 1}
                          aria-label={ar ? `نقل ${s.nameAr} لأسفل` : `Move ${s.nameEn} down`}
                          className="p-1 rounded text-brown/60 hover:text-orange disabled:opacity-30"
                        >
                          <ArrowDown size={14} aria-hidden />
                        </button>
                      </div>
                    </td>
                    <td className="py-2.5">
                      {/* The stable identity. Shown, and never editable: the label may be
                          translated, this may not change. */}
                      <span className="font-mono text-xs bg-cream px-1.5 py-0.5 rounded">{s.code}</span>
                    </td>
                    <td className="py-2.5">
                      <span className="font-bold">{ar ? s.nameAr : s.nameEn}</span>
                      <span className="block text-[11px] text-brown/60">{ar ? s.nameEn : s.nameAr}</span>
                    </td>
                    <td className="py-2.5 text-end tabular-nums">{s.probability}%</td>
                    <td className="py-2.5 text-end tabular-nums">
                      {s._count?.opportunities ?? 0}
                    </td>
                    <td className="py-2.5">
                      <div className="flex gap-1.5 justify-end flex-wrap">
                        <Button variant="ghost" onClick={() => setEditing(s)} testId={`edit-stage-${s.code}`}>
                          {ar ? "تعديل" : "Edit"}
                        </Button>
                        {s.isActive ? (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            testId={`retire-stage-${s.code}`}
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
                          >
                            <EyeOff size={14} aria-hidden /> {ar ? "إخفاء" : "Retire"}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            testId={`restore-stage-${s.code}`}
                            onClick={() =>
                              patch(
                                { id: s.id, isActive: true },
                                ar ? "أُعيدت المرحلة." : "Stage restored.",
                              )
                            }
                          >
                            <Eye size={14} aria-hidden /> {ar ? "إظهار" : "Restore"}
                          </Button>
                        )}
                        {!s.isActive && <Pill tone="neutral">{ar ? "مخفية" : "retired"}</Pill>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <p className="text-[11px] text-brown/60 mt-3 font-medium">
          {ar
            ? "المرحلة تُخفى ولا تُحذف: كل حركة سُجّلت في السجل تشير إليها، وحذفها يكسر التاريخ الذي وُجدت تلك الحركات لحفظه. ومرحلة بها صفقات لا يمكن إخفاؤها — انقل صفقاتها أولاً."
            : "A stage is retired, never deleted: every stage event that ever mentioned it points here, and deleting it would break the history those events exist to preserve. A stage holding deals cannot be retired — move them first."}
        </p>
      </Card>

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
            load();
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

      <p className="text-[11px] text-brown/60 font-medium">
        {ar
          ? "كلا الاسمين مطلوبان. مرحلة بالإنجليزية فقط تظهر كفراغ على اللوحة التي يعمل عليها معظم المستخدمين."
          : "Both names are required. A stage with only an English label renders as a gap on the board most of these users actually work in."}
      </p>
    </Modal>
  );
}
