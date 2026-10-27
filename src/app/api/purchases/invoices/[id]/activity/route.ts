import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { acctError } from "@/lib/accounting/http";
import { requireApRead } from "@/lib/accounting/ops/http";
import { describe, type AuditEntry } from "@/lib/users/audit-format";
import { PURCHASE_ACTIVITY } from "@/lib/accounting/ops/purchase-activity";

type Params = { params: Promise<{ id: string }> };

/**
 * «سجل النشاط» of one purchase invoice (unified inventory phase 2): its rows of the person audit (AuthAuditLog,
 * src/lib/accounting/ops/purchase-activity.ts), oldest first, in the viewer's language. The AP read gate.
 */
export async function GET(request: Request, { params }: Params) {
  const { user, error } = await requireApRead();
  if (error) return error;
  try {
    const id = (await params).id;
    const rows = await prisma.authAuditLog.findMany({
      where: { action: { in: [...PURCHASE_ACTIVITY] }, metadata: { path: ["invoiceId"], equals: id } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 500,
      select: { id: true, userId: true, action: true, result: true, reasonCode: true, sourceInterface: true, metadata: true, occurredAt: true },
    });
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    const asked = new URL(request.url).searchParams.get("lang");
    const lang = asked === "en" || asked === "ar" ? asked : user.preferredLanguage === "en" ? "en" : "ar";
    const entries: AuditEntry[] = rows.map((r) => describe(r, names, lang));
    return NextResponse.json({ entries });
  } catch (err) {
    return acctError(err);
  }
}
