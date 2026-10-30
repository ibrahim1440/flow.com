import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesTeamReports } from "@/lib/services/sales/scope";

/**
 * GET /api/sales/my-day/reps — the reps a team viewer may open «يومي» for (read-only): every active account that is the
 * account owner of at least one customer, by name. No figures, no ranking. Team viewers only (403 otherwise).
 */
export async function GET() {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  if (!seesTeamReports(user.permissions, user.role)) return NextResponse.json({ error: "Only a sales manager may list the reps.", errorAr: "قائمة المندوبين للمدير فقط." }, { status: 403 });
  try {
    const owners = await prisma.customer.groupBy({ by: ["accountOwnerId"], where: { accountOwnerId: { not: null } }, _count: { _all: true } });
    const ids = owners.map((o) => o.accountOwnerId!).filter(Boolean);
    const reps = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
    return NextResponse.json({ reps });
  } catch (err) {
    return handleDomainError(err);
  }
}
