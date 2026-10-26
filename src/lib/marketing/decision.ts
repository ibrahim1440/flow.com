// The campaign decision engine: a verdict, the evidence it rests on, and what it does not know.
// Pure. It PROPOSES; nothing here changes a campaign. Executing a verdict is a separate, approved,
// audited act (services/marketing/decisions.ts).
//
// ── No universal numbers ──
// Every money threshold comes from the campaign's own targets or the product's economics
// (target CAC, target ROAS, break-even ROAS from the gross margin). When none is set the verdict is
// INSUFFICIENT_DATA with "set a target" — never a guess from a generic benchmark. The only built-in
// numbers are statistical tolerances (how big a drop counts as a drop), and they are parameters.

import { breakEvenRoas, ratio, round, type Economics, type Num } from "./kpi";

export type Verdict = "SCALE" | "KEEP" | "OPTIMIZE" | "TEST" | "PAUSE" | "HUMAN_REVIEW" | "INSUFFICIENT_DATA";

export const VERDICT_LABELS: Record<Verdict, { ar: string; en: string; tone: "good" | "neutral" | "warn" | "bad" | "info" }> = {
  SCALE: { ar: "توسيع", en: "Scale", tone: "good" },
  KEEP: { ar: "استمرار دون تغيير", en: "Keep", tone: "neutral" },
  OPTIMIZE: { ar: "تحسين", en: "Optimize", tone: "warn" },
  TEST: { ar: "اختبار إضافي", en: "Test more", tone: "info" },
  PAUSE: { ar: "إيقاف مؤقت", en: "Pause", tone: "bad" },
  HUMAN_REVIEW: { ar: "مراجعة بشرية", en: "Human review", tone: "warn" },
  INSUFFICIENT_DATA: { ar: "بيانات غير كافية", en: "Insufficient data", tone: "neutral" },
};

export type DecisionInput = {
  periodDays: number;
  spend: Num;
  impressions: Num;
  linkClicks: Num;
  /** Store orders attributed to the campaign under the chosen model (may be fractional). */
  orders: Num;
  newCustomers: Num;
  netRevenue: Num;
  previous?: { spend: Num; linkClicks: Num; orders: Num; impressions: Num } | null;
  targets: { targetCac: Num; targetRoas: Num; minSpend: Num; minConversions: Num };
  economics: Economics | null;
  /** Is conversion tracking known to work for this campaign's traffic (UTM orders seen recently)? */
  trackingHealthy: boolean | null;
  /** Hours since the newest metrics row — platforms report late. */
  dataAgeHours: Num;
  /** Remaining budget headroom for the period, SAR (null = no budget set). */
  budgetHeadroom: Num;
  /** Out-of-stock or other known sell-side problems (from inventory / alerts). */
  sellSideIssues: string[];
};

export type Tolerances = {
  /** A drop larger than this fraction counts (0.3 = 30%). */
  dropFraction: number;
  /** ROAS this far above target (fraction) before suggesting scale. */
  scaleMargin: number;
  /** Below this fraction of break-even, losses are large enough to propose a pause. */
  pauseBelowBreakEven: number;
  /** Data younger than this is likely incomplete (platform reporting delay). */
  freshHours: number;
};

export const DEFAULT_TOLERANCES: Tolerances = { dropFraction: 0.3, scaleMargin: 0.2, pauseBelowBreakEven: 0.7, freshHours: 24 };

export type Decision = {
  verdict: Verdict;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  /** 1. current result, 2. target, 3. data used — numbers the screen shows as a table. */
  evidence: Record<string, Num | string | boolean>;
  /** 6. likely cause, in order of what to check first. */
  reasonsAr: string[];
  /** 5. limitations and caveats. */
  limitationsAr: string[];
  /** 7. proposed action. */
  actionAr: string;
  /** 8. expected effect and risk. */
  impactAr: string;
  riskAr: string;
  /** 9. does executing it need a second person? */
  requiresApproval: boolean;
  /** For SCALE: the largest step allowed (fraction), never above the budget's auto cap. */
  maxStep?: number;
};

export function decide(input: DecisionInput, tol: Tolerances = DEFAULT_TOLERANCES, maxAutoIncrease: Num = null): Decision {
  const be = input.economics ? breakEvenRoas(input.economics) : null;
  const cac = ratio(input.spend, input.newCustomers);
  const cpa = ratio(input.spend, input.orders);
  const roas = ratio(input.netRevenue, input.spend);
  const cvr = ratio(input.orders, input.linkClicks);
  const prevCvr = input.previous ? ratio(input.previous.orders, input.previous.linkClicks) : null;
  const prevCtr = input.previous ? ratio(input.previous.linkClicks, input.previous.impressions) : null;
  const ctr = ratio(input.linkClicks, input.impressions);

  // Evidence thresholds: explicit on the campaign, else derived from the campaign's own target CAC.
  const targetCac = input.targets.targetCac;
  const targetRoas = input.targets.targetRoas ?? be;
  const minSpend = input.targets.minSpend ?? (targetCac !== null ? targetCac * 2 : null);
  const minConv = input.targets.minConversions ?? 3;

  const evidence: Decision["evidence"] = {
    periodDays: input.periodDays,
    spend: input.spend, linkClicks: input.linkClicks, orders: input.orders, newCustomers: input.newCustomers,
    netRevenue: input.netRevenue,
    cac: cac === null ? null : round(cac), cpa: cpa === null ? null : round(cpa), roas: roas === null ? null : round(roas),
    cvrPct: cvr === null ? null : round(cvr * 100), targetCac, targetRoas: targetRoas === null ? null : round(targetRoas),
    breakEvenRoas: be, minSpend: minSpend === null ? null : round(minSpend), minConversions: minConv,
    trackingHealthy: input.trackingHealthy === null ? "unknown" : input.trackingHealthy,
    dataAgeHours: input.dataAgeHours,
  };
  const limitations: string[] = [];
  if (input.dataAgeHours !== null && input.dataAgeHours < tol.freshHours) limitations.push("بيانات آخر يوم قد تكون ناقصة بسبب تأخر تقارير المنصات.");
  if (be === null) limitations.push("اقتصاديات المنتج غير مدخلة؛ لا يمكن حساب نقطة التعادل.");
  if (input.trackingHealthy === null) limitations.push("صحة التتبع غير معروفة (لا طلبات بروابط UTM حديثة).");
  limitations.push("الإسناد حسب النموذج المختار، وليس إثباتاً سببياً.");

  const base = (verdict: Verdict, reasons: string[], action: string, impact: string, risk: string, approval: boolean, extra: Partial<Decision> = {}): Decision => ({
    verdict, evidence, reasonsAr: reasons, limitationsAr: limitations, actionAr: action, impactAr: impact, riskAr: risk,
    requiresApproval: approval, confidence: confidenceOf(input.orders, minConv), ...extra,
  });

  if (input.spend === null) {
    return base("INSUFFICIENT_DATA", ["لا توجد بيانات إنفاق لهذه الحملة في الفترة."], "اربط الحساب الإعلاني أو أدخل الإنفاق يدوياً.", "لا أثر قبل توفر البيانات.", "—", false, { confidence: "LOW" });
  }
  if (minSpend === null && targetRoas === null) {
    return base("INSUFFICIENT_DATA", ["لا يوجد هدف تكلفة اكتساب (CAC) ولا هدف عائد (ROAS) ولا اقتصاديات منتج."], "حدد هدف CAC أو ROAS للحملة أو أدخل هامش المنتج.", "بدون هدف لا يمكن الحكم على الأداء.", "—", false, { confidence: "LOW" });
  }
  if (minSpend !== null && input.spend < minSpend) {
    return base("INSUFFICIENT_DATA", [`الإنفاق (${round(input.spend)}) أقل من حد الحكم (${round(minSpend)}).`], "استمر حتى يبلغ الإنفاق حد البيانات الكافية.", "قرار مبكر قد يوقف حملة جيدة.", "—", false, { confidence: "LOW" });
  }

  // Spend without conversions: tracking first, then the sell side, then the ad.
  if ((input.orders ?? 0) === 0) {
    if (input.trackingHealthy !== true) {
      return base("HUMAN_REVIEW", ["إنفاق دون تحويلات مسجلة.", "صحة التتبع غير مؤكدة: تحقق من روابط UTM ونافذة التحويل قبل الحكم على الإعلان."], "افحص التتبع (UTM، البكسل، نافذة الإسناد) ثم أعد التقييم.", "قد تكون التحويلات موجودة وغير مسجلة.", "إيقاف حملة ناجحة بسبب خلل قياس.", true);
    }
    if (input.sellSideIssues.length) {
      return base("HUMAN_REVIEW", ["إنفاق دون تحويلات.", ...input.sellSideIssues.map((s) => `مشكلة في جانب البيع: ${s}`)], "عالج مشكلة المخزون/الدفع/الصفحة قبل تعديل الإعلان.", "الإعلان قد لا يكون السبب.", "هدر إنفاق مستمر حتى المعالجة.", true);
    }
    return base("PAUSE", ["إنفاق تجاوز حد الحكم دون أي طلب منسوب، والتتبع سليم."], "إيقاف مؤقت ومراجعة الجمهور والعرض والتصميم.", `يوقف هدراً بمعدل ${round(input.spend / Math.max(1, input.periodDays))} يومياً تقريباً.`, "قد تكون التحويلات متأخرة إن كانت دورة الشراء أطول من الفترة.", true);
  }

  if ((input.orders ?? 0) < minConv) {
    return base("TEST", [`عدد الطلبات (${round(input.orders ?? 0)}) أقل من الحد الأدنى للحكم (${minConv}).`], "استمر بنفس الميزانية أو اختبر نسخة إعلانية بديلة.", "زيادة العينة ترفع الثقة في القرار.", "—", false);
  }

  // Conversion rate collapsed while the ad still gets clicked: look at the site, not the ad.
  if (cvr !== null && prevCvr !== null && prevCvr > 0 && cvr < prevCvr * (1 - tol.dropFraction) && (ctr === null || prevCtr === null || ctr >= prevCtr * (1 - tol.dropFraction))) {
    return base("HUMAN_REVIEW", [
      `انخفض معدل التحويل من ${round(prevCvr * 100)}% إلى ${round(cvr * 100)}% بينما بقيت نسبة النقر مستقرة.`,
      "افحص صفحة الهبوط، المخزون، الدفع، والعرض قبل تغيير الإعلان.",
      ...input.sellSideIssues,
    ], "مراجعة صفحة الهبوط والمخزون والدفع.", "إصلاح جانب البيع يعيد التحويل دون إنفاق إضافي.", "تعديل الإعلان وحده لن يعالج السبب.", true);
  }

  const belowBE = be !== null && roas !== null && roas < be;
  if (belowBE && roas! < be! * tol.pauseBelowBreakEven) {
    return base("PAUSE", [`العائد (ROAS) ${round(roas!)} أقل بكثير من نقطة التعادل ${be} وفق هامش المساهمة.`], "إيقاف مؤقت ومراجعة الربحية والعرض.", "يوقف خسارة في كل طلب منسوب.", "قد يخسر القيمة طويلة المدى للعملاء الجدد إن كانت مرتفعة.", true);
  }
  const cacOver = targetCac !== null && cac !== null && cac > targetCac;
  const roasUnder = targetRoas !== null && roas !== null && roas < targetRoas;
  if (belowBE || cacOver || roasUnder) {
    const reasons: string[] = [];
    if (belowBE) reasons.push(`العائد (ROAS) ${round(roas!)} أقل من نقطة التعادل ${be}.`);
    if (cacOver) reasons.push(`تكلفة الاكتساب (CAC) ${round(cac!)} أعلى من الهدف ${targetCac}.`);
    if (roasUnder && !belowBE) reasons.push(`العائد (ROAS) ${round(roas!)} أقل من الهدف ${round(targetRoas!)}.`);
    return base("OPTIMIZE", reasons, "حسّن الاستهداف أو التصميم أو العرض، واختبر نسخة A/B قبل زيادة الإنفاق.", "خفض تكلفة الاكتساب (CAC) نحو الهدف.", "التعديل المتكرر يعيد مرحلة التعلم في المنصة.", true);
  }

  // On or above target. Scale only with headroom and a clear margin.
  const scaleBar = targetRoas !== null ? targetRoas * (1 + tol.scaleMargin) : null;
  if (scaleBar !== null && roas !== null && roas >= scaleBar && (input.budgetHeadroom === null || input.budgetHeadroom > 0)) {
    const step = maxAutoIncrease !== null ? Math.min(maxAutoIncrease, 0.2) : 0.2;
    return base("SCALE", [`العائد (ROAS) ${round(roas)} أعلى من الهدف بهامش ${Math.round(tol.scaleMargin * 100)}% أو أكثر.`, cac !== null && targetCac !== null ? `تكلفة الاكتساب (CAC) ${round(cac)} ضمن الهدف ${targetCac}.` : "ضمن حدود الربحية."],
      `زيادة تدريجية للميزانية بحد أقصى ${Math.round(step * 100)}% ضمن سقف الميزانية.`, "مزيد من الطلبات بعائد قريب من الحالي.", "العائد (ROAS) يتناقص عادة مع التوسع؛ راقب تكلفة الاكتساب (CAC) بعد كل خطوة.", true, { maxStep: step });
  }
  return base("KEEP", ["الأداء ضمن الأهداف."], "استمر دون تغيير وراقب.", "استقرار النتائج.", "—", false);
}

function confidenceOf(orders: Num, minConv: number): Decision["confidence"] {
  if (orders === null || orders < minConv) return "LOW";
  if (orders < minConv * 3) return "MEDIUM";
  return "HIGH";
}
