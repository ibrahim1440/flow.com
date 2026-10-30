import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesTeamReports } from "@/lib/services/sales/scope";
import { teamOverview } from "@/lib/services/sales/team-overview";

export const dynamic = "force-dynamic";

/**
 * GET /api/sales/team — «متابعة الفريق» (batch 24 WP-C): one row per rep, sorted by name, for the sales manager and
 * the admin only (seesTeamReports — the same gate as the team's sales reports). A rep gets 403: their own day is
 * «يومي». Figures are defined in services/sales/team-overview.ts.
 */
export async function GET() {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  if (!seesTeamReports(user.permissions, user.role)) {
    return NextResponse.json({ error: "متابعة الفريق لمدير المبيعات والمسؤول فقط.", errorEn: "The team overview is for the sales manager and the admin only." }, { status: 403 });
  }
  try {
    return NextResponse.json(await teamOverview(prisma, { selfId: user.id }));
  } catch (err) {
    return handleDomainError(err);
  }
}
