import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import {
  applyOpeningChanges, getCommissionSettings, openingChangesFromCsv, openingCsv, openingRows, type OpeningChange,
} from "@/lib/services/commissions/settings";

/**
 * «تهيئة العملاء الحاليين قبل تفعيل العمولات» — the opening setup, `commissions › manage_settings`.
 *
 * GET               every customer: the owning rep («المسؤول»), the prior collected orders (blank =
 *                   existing client, the default), the new-client exclusion; and the recent log.
 * GET ?format=csv   the same as CSV: customerId, customer, rep, priorOrders, excluded.
 * PATCH             inline changes { changes: [{ customerId, repId?, priorOrders?, excluded? }], reason }.
 * POST              CSV import { csv, dryRun? }: all rows checked first; any bad row → nothing applied.
 *
 * Every change is logged per customer (before / after, actor, source INLINE | CSV). After the
 * activation date the screen remains the audited «تعديل ترتيب الطلب» for exceptional cases, and a
 * reason is then required. The change reaches a month at its next recomputation (a collection,
 * the monthly run), never an approved figure.
 */
async function needsReason(reason: string): Promise<boolean> {
  const s = await getCommissionSettings(prisma);
  return !!s.activationDate && s.activationDate.getTime() <= Date.now() && reason.trim().length < 3;
}
const REASON_AFTER_ACTIVATION = {
  _appCode: 400,
  message: "العمولات مفعّلة: تعديل ترتيب الطلب بعد التفعيل استثنائي ويحتاج سبباً.",
  errorEn: "Commissions are active: changing the order sequence after activation is exceptional and needs a reason.",
};

export async function GET(request: Request) {
  const { error } = await requireSub("commissions", "manage_settings");
  if (error) return error;
  try {
    const settings = await getCommissionSettings(prisma);
    const rows = await openingRows(prisma, settings.activationDate);
    if (new URL(request.url).searchParams.get("format") === "csv") {
      return new NextResponse(openingCsv(rows), {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="commission-opening.csv"' },
      });
    }
    const [reps, log] = await Promise.all([
      prisma.employee.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, username: true } }),
      prisma.commissionAuditLog.findMany({ where: { kind: { in: ["OPENING", "EXCLUSION"] } }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    const active = !!settings.activationDate && settings.activationDate.getTime() <= Date.now();
    return NextResponse.json({ settings, active, rows, reps, log });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function PATCH(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_settings");
  if (error) return error;
  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const reason = typeof b.reason === "string" ? b.reason : "";
  const raw = Array.isArray(b.changes) ? b.changes : [];
  const changes: OpeningChange[] = raw.map((x) => {
    const c = (x ?? {}) as Record<string, unknown>;
    return {
      customerId: String(c.customerId ?? ""),
      ...(c.repId !== undefined ? { repId: c.repId === null || c.repId === "" ? null : String(c.repId) } : {}),
      ...(c.priorOrders !== undefined ? { priorOrders: c.priorOrders === null || c.priorOrders === "" ? null : Number(c.priorOrders) } : {}),
      ...(typeof c.excluded === "boolean" ? { excluded: c.excluded } : {}),
      ...(typeof c.exclusionReason === "string" ? { exclusionReason: c.exclusionReason } : {}),
    };
  });
  try {
    if (await needsReason(reason)) throw REASON_AFTER_ACTIVATION;
    const out = await prisma.$transaction((tx) => applyOpeningChanges(tx, changes, { actorId: user.id, source: "INLINE", reason }), TX_OPTS);
    return NextResponse.json(out);
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("commissions", "manage_settings");
  if (error) return error;
  let b: Record<string, unknown>;
  try {
    b = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const csv = typeof b.csv === "string" ? b.csv : "";
  if (!csv.trim()) return NextResponse.json({ error: "The CSV is empty." }, { status: 400 });
  if (csv.length > 2_000_000) return NextResponse.json({ error: "The CSV is larger than 2 MB." }, { status: 400 });
  const reason = typeof b.reason === "string" ? b.reason : "";
  try {
    const [customers, reps] = await Promise.all([
      prisma.customer.findMany({ select: { id: true, name: true } }),
      prisma.employee.findMany({ where: { active: true }, select: { id: true, name: true, username: true } }),
    ]);
    const { changes, errors } = openingChangesFromCsv(csv, customers, reps);
    if (errors.length > 0) return NextResponse.json({ error: "الملف فيه أخطاء؛ لم يُطبَّق شيء.", errorEn: "The file has errors; nothing was applied.", errors }, { status: 400 });
    if (b.dryRun === true) return NextResponse.json({ dryRun: true, rows: changes.length });
    if (await needsReason(reason)) throw REASON_AFTER_ACTIVATION;
    const out = await prisma.$transaction((tx) => applyOpeningChanges(tx, changes, { actorId: user.id, source: "CSV", reason }), TX_OPTS);
    return NextResponse.json({ rows: changes.length, ...out });
  } catch (err) {
    return handleDomainError(err);
  }
}
