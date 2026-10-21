import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAdminAction, requireModule, requireEdit } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { getCuppingSettings, policyView, scorerCounts } from "@/lib/cupping/close-policy";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireModule("cupping");
  if (error) return error;

  const { id } = await params;

  const session = await prisma.cuppingSession.findUnique({
    where: { id },
    include: {
      batch: { select: { batchNumber: true } },
      greenBean: { select: { serialNumber: true, beanType: true } },
      sessionBatches: {
        orderBy: { order: "asc" },
        include: {
          batch: {
            select: {
              batchNumber: true, roastProfile: true,
              greenBean: { select: { beanType: true, serialNumber: true } },
              orderItem: { select: { beanTypeName: true } },
            },
          },
        },
      },
      scores: {
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // E6: the scorer counts and the applicable minimum — counts only, blind-safe.
  const [counts, settings] = await Promise.all([scorerCounts([id]), getCuppingSettings()]);
  // Plus each staff scorer's progress (name and cups scored, owner decision 3) — never a score.
  const policy = { ...policyView(session, counts.get(id), settings.minScorers), scorerProgress: counts.get(id)?.progress ?? [] };

  // Blind mode: while Open, only return the current user's own scores
  // (filter, not find — multi-cup sessions produce one score per cup)
  if (session.status === "Open") {
    const myScores = session.scores.filter((s) => s.employeeId === user.id);
    return NextResponse.json({ ...session, ...policy, scores: myScores, blind: true });
  }

  return NextResponse.json({ ...session, ...policy, blind: false });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireEdit("cupping");
  if (error) return error;
  // Closing and deleting a session are administrator actions: the cupping screen offers
  // them only when `user.role === "admin"`. Cupping edit access alone (create, score) is
  // not enough; the same rule is enforced here so the API cannot be called around the UI. The
  // admin role is privileged: a verified individual, and deleting needs a recent step-up.
  const refused = await requireAdminAction(user, "cupping.session_delete", { stepUp: true });
  if (refused) return refused;

  const { id } = await params;
  try {
    await prisma.cuppingSession.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
