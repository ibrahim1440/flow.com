import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { listRecurrences, riyadhIso } from "@/lib/services/sales/plans";
import { mySupervisors, searchPeople } from "@/lib/services/sales/plan-people";

/** The fixed suggestions of «وش هو؟» for a report (owner decision c: three fixed + the rep's last three). */
const REPORTS = ["تقرير المبيعات الأسبوعي", "تحديث أسعار المنافسين", "ترتيب ملفات العملاء"];

/**
 * GET /api/sales/plan/internal — D17 «شغلي»: what the add sheet and the planner offer the caller in one read —
 *   people:      the caller's HR manager («المشرف»), then the colleagues they invited lately (names only);
 *   team:        the colleagues under the same HR manager («كل الفريق»);
 *   areas:       the last three field-round places («آخر الأماكن»);
 *   reports:     the fixed report suggestions + the caller's last three;
 *   repeating:   the caller's running weekly rules («خطتي ← المتكرر»);
 *   canAddLeads: «أضف عميل محتمل» in a field round needs sales › lead_write;
 *   inPlan:      the meetings (appointment ids) already in the caller's plan from today on — «يومي» does not offer them again.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    // ?q= — «مع مين؟» search: the name, the HR job title, or a role word (→ the supervisors). Names only.
    const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, 60) ?? "";
    if (q) return NextResponse.json({ found: await searchPeople(prisma, q, user.id) }, { headers: { "Cache-Control": "no-store" } });
    const today = riyadhIso(new Date());
    const [me, recent, repeating, planned] = await Promise.all([
      prisma.hrEmployee.findUnique({ where: { accountId: user.id }, select: { managerId: true, manager: { select: { accountId: true } } } }),
      prisma.salesPlanItem.findMany({ where: { employeeId: user.id, category: { in: ["MEETING", "FIELD_ROUND", "REPORT"] } }, orderBy: { createdAt: "desc" }, take: 60,
        select: { category: true, attendeeIds: true, area: true, label: true } }),
      listRecurrences(prisma, user.id, today),
      prisma.salesPlanItem.findMany({ where: { employeeId: user.id, appointmentId: { not: null }, plannedDay: { gte: new Date(`${today}T00:00:00Z`) } }, select: { appointmentId: true } }),
    ]);
    // «مشرفي» (Abu Fahd; D18 B2): ONE person — the HR manager, else the first sales supervisor by role (never the admin
    // role); the other supervisors are offered without the mark.
    const sup = await mySupervisors(prisma, user.id);
    const managerId = sup.first?.id ?? null;
    const bosses = sup.others;
    const teamIds = me?.managerId
      ? (await prisma.hrEmployee.findMany({ where: { managerId: me.managerId, accountId: { not: null } }, select: { accountId: true } })).map((r) => r.accountId!).filter((id) => id !== user.id)
      : [];
    const invited: string[] = [];
    for (const r of recent) for (const a of r.attendeeIds) if (!invited.includes(a) && a !== managerId && !bosses.some((b) => b.id === a)) invited.push(a);
    const wanted = [...new Set([...(managerId ? [managerId] : []), ...bosses.map((b) => b.id), ...invited.slice(0, 3), ...teamIds])];
    const names = new Map((await prisma.employee.findMany({ where: { id: { in: wanted }, active: true }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    const person = (id: string, role?: "manager" | "recent") => (names.has(id) ? { id, name: names.get(id)!, ...(role ? { role } : {}) } : null);
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    return NextResponse.json({
      me: user.id,
      people: [managerId ? person(managerId, "manager") : null, ...invited.slice(0, 3).map((id) => person(id, "recent")), ...bosses.map((b) => person(b.id))].filter(Boolean),
      team: teamIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
      areas: uniq(recent.filter((r) => r.category === "FIELD_ROUND").map((r) => r.area)).slice(0, 3),
      reports: uniq([...REPORTS, ...recent.filter((r) => r.category === "REPORT").map((r) => r.label)]).slice(0, REPORTS.length + 3),
      repeating,
      canAddLeads: hasSubPrivilege(user.permissions, "sales", "lead_write"),
      inPlan: planned.map((p) => p.appointmentId!),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return handleDomainError(e); }
}
