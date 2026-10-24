import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { COMMISSION_TEMPLATES, cloneComponents, templateByKey } from "@/lib/services/commissions/builder";
import { createPlan } from "@/lib/services/commissions/plans";
import { getCommissionSettings } from "@/lib/services/commissions/settings";
import { Decimal, riyadhMonthStart } from "@/lib/services/commissions/engine";

/**
 * Ready-made commission plan templates («قالب جاهز»).
 *
 * GET  — the list (a list, so more templates can be added beside «نموذج حقبة الحالي»), each with
 *        its components and the short Arabic explanation of every component, from the policy text.
 * POST — one click: a NEW, editable plan prefilled EXACTLY with the template's values, version 1
 *        effective from the commission activation date (else the start of the current Riyadh
 *        month, or `effectiveFrom`). Nobody is put
 *        on it; until somebody is, its version can still be edited in place.
 * Both behind `manage_plans`, like every plan route.
 */
export async function GET() {
  const { error } = await requireSub("commissions", "manage_plans");
  if (error) return error;
  return NextResponse.json({
    templates: COMMISSION_TEMPLATES.map((t) => ({
      key: t.key, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn,
      descriptionAr: t.descriptionAr, descriptionEn: t.descriptionEn,
      components: t.components, explanations: t.explanations,
    })),
  });
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_plans");
  if (error) return error;
  let body: Record<string, unknown> = {};
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const t = templateByKey(typeof body.templateKey === "string" ? body.templateKey : "");
  if (!t) return NextResponse.json({ error: "Unknown template." }, { status: 404 });

  // Default: from the commission activation date when it is set (nothing is computed before it),
  // else from the start of the current Riyadh month.
  const settings = await getCommissionSettings(prisma);
  const effectiveFrom = body.effectiveFrom ? new Date(String(body.effectiveFrom)) : settings.activationDate ?? riyadhMonthStart(new Date());
  if (Number.isNaN(effectiveFrom.getTime())) {
    return NextResponse.json({ error: "effectiveFrom is not a date." }, { status: 400 });
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // A free code: the template's own, then -2, -3 … so the button can be pressed twice.
      let code = typeof body.code === "string" && body.code.trim() ? body.code.trim().toUpperCase() : t.code;
      if (!(typeof body.code === "string" && body.code.trim())) {
        for (let n = 2; await tx.commissionPlan.findUnique({ where: { code }, select: { id: true } }); n++) code = `${t.code}-${n}`;
      }
      return createPlan(tx, {
        code,
        name: typeof body.name === "string" && body.name.trim() ? body.name : t.nameEn,
        nameAr: typeof body.nameAr === "string" && body.nameAr.trim() ? body.nameAr : t.nameAr,
        description: t.descriptionAr,
        templateKey: t.key,
        version: {
          baseRatePercent: new Decimal(0), tierMode: "INCREMENTAL", currency: "SAR",
          effectiveFrom, effectiveTo: null, tiers: [], components: cloneComponents(t.components),
        },
        actorId: user.id,
      });
    }, TX_OPTS);
    return NextResponse.json({ ...created, templateKey: t.key }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
