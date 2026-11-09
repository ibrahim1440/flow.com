import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { PlanError, loadPlan, moveItem, nextWorkDay, riyadhIso } from "@/lib/services/sales/plans";

/**
 * POST /api/sales/plan/carry { ids?: string[] } — D16 «باقي N ما خلصت › انقلها لبكرة»: the caller's open items planned for
 * today (all of them, or the listed ones) move to the next working day, an appointment with its time. An action whose twin
 * (same kind, same customer) is already planned that day merges into it.
 * Answers what moved, with each one's day and time before, so «تراجع» can put them back (PATCH …/items/:id).
 */
export async function POST(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
    const want = Array.isArray(body.ids) ? new Set(body.ids.filter((x): x is string => typeof x === "string")) : null;
    const today = riyadhIso(new Date());
    const plan = await loadPlan(prisma, user.id, "DAY", today);
    // D17: a meeting someone else organised is theirs to move — it stays on today.
    const open = plan.items.filter((i) => i.kind !== "GOAL" && !i.checked && i.plannedDay === today && !i.invitedBy && (!want || want.has(i.id)));
    const to = nextWorkDay(today);
    // The twin rule (gate, 9 Nov): carried into a week that already has the same action for the customer, the two merge.
    const merged: { removedId: string; keptId: string }[] = [];
    const skipped: string[] = [];
    await prisma.$transaction(async (tx) => {
      // The appointment keeps its time on the next day («أبو فهد»: a carried appointment silently lost it).
      for (const i of open) { const r = await moveItem(tx, i.id, to, today, i.plannedTime, "merge"); if (r.merged) merged.push({ removedId: r.removedId, keptId: r.keptId }); else if (r.skipped) skipped.push(i.id); }
    });
    const gone = new Set([...merged.map((m) => m.removedId), ...skipped]);
    // «تراجع» puts back what moved; a merged one stays merged (it is the same thing as the one already planned there).
    // `skipped`: two of the supervisor's for the same customer on that day — left on today, not merged (gate).
    return NextResponse.json({ ok: true, to, merged: merged.length, skipped: skipped.length,
      moved: open.filter((i) => !gone.has(i.id)).map((i) => ({ id: i.id, plannedDay: i.plannedDay, plannedTime: i.plannedTime })) });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.ar, errorEn: e.message, code: e.code }, { status: e.status });
    return handleDomainError(e);
  }
}
