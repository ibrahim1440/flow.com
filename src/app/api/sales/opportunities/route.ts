import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";

/**
 * GET /api/sales/opportunities — the pipeline, with its stages.
 *
 * Returns the stages as well as the deals, because a Kanban with no columns is useless and
 * the columns are configuration rather than a constant in the client. Scoped in the WHERE
 * clause: a rep sees their own deals, and seeing everyone's is its own privilege.
 */
export async function GET() {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");

  try {
    const [stages, deals] = await Promise.all([
      prisma.pipelineStage.findMany({
        where: { isActive: true },
        orderBy: { position: "asc" },
        select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true },
      }),
      prisma.opportunity.findMany({
        where: seesAll ? {} : { ownerId: user.id },
        orderBy: [{ outcome: "asc" }, { expectedCloseAt: { sort: "asc", nulls: "last" } }],
        take: 300,
        select: {
          id: true, title: true, stageId: true, outcome: true, lostReason: true,
          amount: true, currency: true, probability: true,
          expectedCloseAt: true, nextFollowUpAt: true, closedAt: true,
          customer: { select: { id: true, name: true, nameAr: true } },
          owner: { select: { id: true, name: true } },
          _count: { select: { quotes: true, samples: true, activities: true } },
          quotes: { where: { status: "ACCEPTED" }, select: { id: true }, take: 1 },
        },
      }),
    ]);

    return NextResponse.json({
      stages,
      deals,
      scope: seesAll ? "all" : "own",
      can: {
        // Reported so the client can show the right controls, while the server re-checks
        // every one of them anyway. The client's copy is a convenience, not the gate.
        close: hasSubPrivilege(user.permissions, "sales", "deal_close"),
        reopen: hasSubPrivilege(user.permissions, "sales", "deal_reopen"),
      },
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}
