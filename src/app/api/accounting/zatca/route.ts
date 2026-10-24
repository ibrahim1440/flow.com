import { NextResponse } from "@/lib/api-response";
import { requireAdminAction, requireSub } from "@/lib/auth-server";
import { auditFromRequest } from "@/lib/accounting/audit";
import { prisma } from "@/lib/db";
import { cronSecretConfigured } from "@/lib/cron/auth";
import { zatcaAbilities } from "@/lib/zatca/access";
import { BASE_URLS, effectiveMode, productionAllowed, serverEnabled, usingMock } from "@/lib/zatca/config";
import { zatcaKey } from "@/lib/zatca/crypto";
import { egsView, seriesCounters, setMode } from "@/lib/zatca/egs";
import { queueStats } from "@/lib/zatca/pipeline";
import { zatcaError } from "@/lib/zatca/refusals";

export const dynamic = "force-dynamic";

/**
 * GET /api/accounting/zatca — the e-invoicing overview (ZT-20): the switch (stored and effective), what the server
 * allows (never a secret's value), the EGS units (never a key, token or secret), the queue counts, the numbering
 * counters, the viewer's abilities. accounting › zatca_view.
 */
export async function GET() {
  const { user, error } = await requireSub("accounting", "zatca_view");
  if (error) return error;
  try {
    const s = await prisma.zatcaSettings.findUnique({ where: { id: "singleton" } });
    const units = await prisma.zatcaEgsUnit.findMany({ include: { csids: true }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({
      settings: { stored: s?.mode ?? "OFF", effective: effectiveMode(s?.mode), activeEgsId: s?.activeEgsId ?? null, updatedAt: s?.updatedAt ?? null },
      server: {
        enabled: serverEnabled(), productionAllowed: productionAllowed(), keyConfigured: !!zatcaKey(), cronSecretConfigured: cronSecretConfigured(),
        endpoints: { SANDBOX: usingMock("SANDBOX") ? "mock" : BASE_URLS.SANDBOX, SIMULATION: usingMock("SIMULATION") ? "mock" : BASE_URLS.SIMULATION, PRODUCTION: BASE_URLS.PRODUCTION },
      },
      units: units.map(egsView),
      queue: await queueStats(),
      counters: await seriesCounters(),
      can: zatcaAbilities(user.permissions, user.role),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return zatcaError(err);
  }
}

/** PUT /api/accounting/zatca { mode, activeEgsId } — the e-invoicing switch. Admin + accounting › zatca_onboard + step-up. */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("accounting", "zatca_onboard");
  if (error) return error;
  const refused = await requireAdminAction(user, "accounting.zatca_onboard", { stepUp: true });
  if (refused) return refused;
  try {
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const s = await setMode({ mode: b.mode, activeEgsId: b.activeEgsId }, auditFromRequest(request, user.id, "e-invoicing switch"));
    return NextResponse.json({ settings: { stored: s.mode, effective: effectiveMode(s.mode), activeEgsId: s.activeEgsId } });
  } catch (err) {
    return zatcaError(err);
  }
}
