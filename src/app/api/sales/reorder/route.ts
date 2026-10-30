import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesTeamReports } from "@/lib/services/sales/scope";
import { factorsFrom, reorderSuggestions } from "@/lib/services/customers/reorder";
import { changedKeys, pick, writeSettingsAudit } from "@/lib/services/settings/audit";

/**
 * GET /api/sales/reorder — «متابعة إعادة الشراء»: the accounts due, late or gone quiet against their own
 * reorder rhythm (services/customers/reorder.ts), most overdue first. A rep reads the accounts they are
 * responsible for; the sales manager and the admin read every account, or one owner's (?ownerId=).
 * The factors in force come with the list, so the screen can say what «متأخر» means.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  try {
    // The scope is the session's: a rep reads their own book whatever `ownerId` says; a team-view caller
    // (the sales manager, the admin) reads one owner's or — explicitly — everyone's.
    const team = seesTeamReports(user.permissions, user.role);
    const asked = new URL(request.url).searchParams.get("ownerId");
    const scope = team ? (asked ? { ownerId: asked } : { scope: "all" as const }) : { ownerId: user.id };
    const [rows, config] = await Promise.all([
      reorderSuggestions(prisma, { ...scope, limit: 200 }),
      prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { reorderLateFactor: true, reorderInactiveFactor: true } }),
    ]);
    return NextResponse.json({ scope: team ? "team" : "own", factors: factorsFrom(config), rows });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PUT /api/sales/reorder — the two factors (sales › stage_manage, the sales settings' key).
 * Body { lateFactor: 1–5 | null, inactiveFactor: 1–10 | null }; null restores the built-in value.
 */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("sales", "stage_manage");
  if (error) return error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  const b = (body ?? {}) as Record<string, unknown>;
  const read = (v: unknown, max: number): number | null | "bad" => {
    if (v === null || v === "") return null;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= max ? Math.round(n * 100) / 100 : "bad";
  };
  const late = "lateFactor" in b ? read(b.lateFactor, 5) : undefined;
  const inactive = "inactiveFactor" in b ? read(b.inactiveFactor, 10) : undefined;
  if (late === "bad" || inactive === "bad") {
    return NextResponse.json({ error: "المعاملان أرقام: التأخر من 1 إلى 5، والانقطاع من 1 إلى 10.", errorEn: "The late factor is 1–5 and the inactive factor 1–10." }, { status: 400 });
  }
  try {
    const current = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { reorderLateFactor: true, reorderInactiveFactor: true } });
    const nextLate = late !== undefined ? late : current?.reorderLateFactor != null ? Number(current.reorderLateFactor) : null;
    const nextInactive = inactive !== undefined ? inactive : current?.reorderInactiveFactor != null ? Number(current.reorderInactiveFactor) : null;
    if (nextLate !== null && nextInactive !== null && nextInactive <= nextLate) {
      return NextResponse.json({ error: "معامل الانقطاع يجب أن يكون أكبر من معامل التأخر.", errorEn: "The inactive factor must be above the late factor." }, { status: 400 });
    }
    const data = { reorderLateFactor: nextLate, reorderInactiveFactor: nextInactive };
    const before = {
      reorderLateFactor: current?.reorderLateFactor != null ? Number(current.reorderLateFactor) : null,
      reorderInactiveFactor: current?.reorderInactiveFactor != null ? Number(current.reorderInactiveFactor) : null,
    };
    const changed = changedKeys(before, data);
    // Audited before / after in the settings trail (council gate S6b), in the same transaction as the change.
    await prisma.$transaction(async (tx) => {
      await tx.systemConfig.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
      if (changed.length) {
        await writeSettingsAudit(tx, {
          section: "organisation", action: "SETTINGS_UPDATED", entityType: "SystemConfig", entityId: "singleton",
          changed, before: pick(before, changed), after: pick(data, changed), actor: { id: user.id, name: user.name },
        });
      }
    });
    return NextResponse.json({ factors: factorsFrom({ reorderLateFactor: nextLate === null ? null : String(nextLate), reorderInactiveFactor: nextInactive === null ? null : String(nextInactive) }) });
  } catch (err) {
    return handleDomainError(err);
  }
}
