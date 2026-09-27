import type { Prisma as PrismaNS } from "@/generated/prisma/client";

type Tx = PrismaNS.TransactionClient;

/**
 * Which stage the automation means when it says "Qualification" or "Quotation".
 *
 * ── Why this is a stored purpose and not a lookup by name or code ──
 * The lifecycle has to put a newly-qualified lead somewhere and move a quoted deal
 * somewhere else. Three obvious ways to decide where, and all three are wrong:
 *
 *   By Arabic name  — the labels are editable and translated. A roastery renaming
 *                     «تأهيل» to «فرز أولي» would silently break qualification.
 *   By code         — plausible, until you look: this deployment's codes are `UAT_QUALIFY`
 *                     and `UAT_PROPOSAL`. Any regex that matches those matches by accident.
 *   By position     — inserting a stage at position 2 redirects the automation to it
 *                     without anybody deciding that.
 *
 * So the meaning is configured once, next to the stages themselves, and read from there.
 * A unique index allows at most one stage per purpose.
 *
 * ── Why an unconfigured purpose refuses instead of guessing ──
 * The alternative is a fallback, and every fallback here is a guess about which column
 * somebody's deals land in. A refusal that names the settings screen is recoverable in
 * thirty seconds; deals quietly accumulating in the wrong column is not, because nobody
 * finds out until the forecast is wrong.
 */
export type StagePurpose = "QUALIFICATION" | "QUOTATION";

const WHAT: Record<StagePurpose, { en: string; ar: string }> = {
  QUALIFICATION: { en: "Qualification", ar: "التأهيل" },
  QUOTATION: { en: "Quotation", ar: "عرض السعر" },
};

export type ResolvedStage = { id: string; code: string; position: number };

/**
 * The stage configured for this purpose, or `null` when none is.
 *
 * Returns null rather than throwing so a read path (a screen explaining that automation is
 * not configured) does not have to catch. Write paths use `requireStageFor`.
 */
export async function stageFor(tx: Tx, purpose: StagePurpose): Promise<ResolvedStage | null> {
  const stage = await tx.pipelineStage.findFirst({
    where: { purpose, isActive: true },
    select: { id: true, code: true, position: true },
  });
  return stage ?? null;
}

/** As `stageFor`, but a missing configuration is a refusal that says how to fix it. */
export async function requireStageFor(tx: Tx, purpose: StagePurpose): Promise<ResolvedStage> {
  const stage = await stageFor(tx, purpose);
  if (stage) return stage;
  throw {
    _appCode: 409,
    message:
      `No pipeline stage is configured as the ${WHAT[purpose].en} stage, so this cannot be ` +
      "done automatically. Set one in Sales settings, or move the deal by hand.",
    messageAr:
      `لا توجد مرحلة مُهيَّأة بوصفها مرحلة ${WHAT[purpose].ar}، فتعذّر تنفيذ ذلك تلقائياً. ` +
      "حدّد واحدة من إعدادات المبيعات، أو انقل الصفقة يدوياً.",
  };
}

/**
 * Should a deal at `fromPosition` be advanced to `toPosition`?
 *
 * Forward only. A deal already in Negotiation does not go back to Quotation because a
 * second quotation was issued, and a deal that has passed Qualification does not return to
 * it because somebody logged another meeting. The automation's job is to stop work being
 * lost, never to undo a human's decision about where a deal actually is.
 */
export function advancesForward(fromPosition: number, toPosition: number): boolean {
  return toPosition > fromPosition;
}
