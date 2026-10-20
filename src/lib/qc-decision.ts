/**
 * The QC decision rules (owner decisions D1–D3, gap G26), pure: no database, no request. Applied by
 * src/lib/services/qc-finalize.ts for POST /api/qc/[batchId]/finalize and /api/qc-records/bulk-finalize,
 * and asserted directly by tests/ops/unit/production-simplify.test.ts.
 */
/** The longest reason accepted (the order timeline's REASON_MAX_LENGTH). */
const REASON_MAX_LENGTH = 500;

export type QcOutcome = "Passed" | "Rejected";

export type QcDecisionInput = {
  outcome: QcOutcome;
  finalDecisionReason?: string | null;
  override?: boolean;
  overrideReason?: string | null;
  confirmed?: boolean;
};

export type QcDecisionRefusal = { ok: false; status: number; code: string; error: string; errorEn: string; min?: number; count?: number };
export type QcDecisionOk = { ok: true; overrideApplied: boolean; decisionReason: string | null; overrideReason: string | null };

const OVERRIDE_REASON_MIN = 3;
const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function qcDecisionCheck(args: {
  input: QcDecisionInput;
  records: { decision: string }[];
  min: number;
  canOverride: boolean;
}): QcDecisionOk | QcDecisionRefusal {
  const { input, records, min, canOverride } = args;
  const count = records.length;
  const accepts = records.filter((r) => r.decision === "Accept").length;
  const rejects = count - accepts;
  const finalReason = clean(input.finalDecisionReason);
  const overrideReason = clean(input.overrideReason);

  if (count === 0) {
    return { ok: false, status: 400, code: "QC_NO_RECORDS", error: "لا توجد تقييمات لهذه الدفعة بعد.", errorEn: "No QC records submitted yet" };
  }
  if (finalReason.length > REASON_MAX_LENGTH || overrideReason.length > REASON_MAX_LENGTH) {
    return { ok: false, status: 400, code: "QC_REASON_TOO_LONG", error: `السبب ${REASON_MAX_LENGTH} حرفًا على الأكثر.`, errorEn: `A reason is at most ${REASON_MAX_LENGTH} characters.` };
  }

  let overrideApplied = false;
  if (count < min) {
    if (input.override !== true) {
      return {
        ok: false, status: 409, code: "QC_MIN_EVALUATORS", min, count,
        error: `هذه الدفعة قيّمها ${count} من ${min} مقيّمين على الأقل. انتظر تقييمًا آخر أو ادعُ ضيفًا، أو اعتمد اعتمادًا استثنائيًا إن كانت لديك الصلاحية.`,
        errorEn: `This batch has ${count} of the minimum ${min} evaluations. Wait for another evaluator or invite a guest, or take an exceptional approval if you hold that permission.`,
      };
    }
    if (!canOverride) {
      return {
        ok: false, status: 403, code: "QC_OVERRIDE_FORBIDDEN", min, count,
        error: "الاعتماد بأقل من الحد الأدنى للمقيّمين يحتاج صلاحية «اعتماد استثنائي بأقل من الحد الأدنى».",
        errorEn: "Approving with fewer evaluators than the minimum needs the «exceptional approval» permission (qc › finalize_override).",
      };
    }
    if (overrideReason.length < OVERRIDE_REASON_MIN) {
      return { ok: false, status: 400, code: "QC_OVERRIDE_REASON", min, count, error: "اكتب سبب الاعتماد الاستثنائي.", errorEn: "An exceptional approval needs a written reason (overrideReason)." };
    }
    if (input.confirmed !== true) {
      return { ok: false, status: 400, code: "QC_OVERRIDE_CONFIRM", min, count, error: "أكّد تحمّل مسؤولية الاعتماد الاستثنائي.", errorEn: "An exceptional approval must be confirmed explicitly (confirmed: true)." };
    }
    overrideApplied = true;
  }

  if (input.outcome === "Passed" && accepts === 0) {
    return { ok: false, status: 409, code: "QC_PASS_WITHOUT_ACCEPT", error: "لا يمكن قبول دفعة دون تقييم «مقبولة» واحد على الأقل.", errorEn: "Cannot pass a batch without at least one accepted QC record." };
  }

  const disagrees = (input.outcome === "Passed" && rejects > 0) || (input.outcome === "Rejected" && accepts > 0);
  const decisionReason = finalReason || (overrideApplied && disagrees ? overrideReason : "");
  if (disagrees && !decisionReason) {
    return input.outcome === "Passed"
      ? { ok: false, status: 400, code: "QC_DISAGREEMENT_REASON", error: "اكتب سبب قبول دفعة رفضها أحد المقيّمين.", errorEn: "Final decision reason is required when passing a batch with rejected QC records." }
      : { ok: false, status: 400, code: "QC_DISAGREEMENT_REASON", error: "اكتب سبب رفض دفعة قبلها أحد المقيّمين.", errorEn: "Final decision reason is required when rejecting a batch with accepted QC records." };
  }

  return { ok: true, overrideApplied, decisionReason: decisionReason || null, overrideReason: overrideApplied ? overrideReason : null };
}

