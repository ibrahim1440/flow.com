import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAdminAction, requireAuth } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

/**
 * One customer's archived messages (batch 25b, owner decisions 31 Oct 2026) — the ADMINISTRATOR only, after a recent step-up:
 *   GET  → { legalHold, legalHoldAt, archived } (how many archived messages the customer has);
 *   PUT  { legalHold: boolean, reason } → the per-customer legal hold (while on, neither the 5-year retention nor an
 *        erasure destroys them), audited with the reason;
 *   POST { action: "erase", reason } → «حذف رسائل العميل من الأرشيف»: the data-subject erasure through the database's only
 *        controlled path (message_archive_erase_customer: refuses under a legal hold, writes the audit row with the count).
 */
type Ctx = { params: Promise<{ id: string }> };
const reasonOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 300) : "");

const ADMIN_ONLY = "أرشيف رسائل العميل لمدير النظام فقط.";

export async function GET(_req: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "customers.message_archive", { stepUp: true, message: ADMIN_ONLY });
  if (refused) return refused;
  const { id } = await params;
  const c = await prisma.customer.findUnique({ where: { id }, select: { messageLegalHold: true, messageLegalHoldAt: true } });
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const archived = await prisma.messageArchive.count({ where: { customerId: id } });
  return NextResponse.json({ legalHold: c.messageLegalHold, legalHoldAt: c.messageLegalHoldAt, archived });
}

export async function PUT(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "customers.message_archive", { stepUp: true, message: ADMIN_ONLY });
  if (refused) return refused;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { legalHold?: unknown; reason?: unknown };
  if (typeof body.legalHold !== "boolean") return NextResponse.json({ error: "طلب غير صالح.", errorEn: "legalHold must be true or false." }, { status: 400 });
  const reason = reasonOf(body.reason);
  if (reason.length < 5) return NextResponse.json({ error: "اكتب السبب (5 أحرف على الأقل).", errorEn: "A reason of at least 5 characters is required.", code: "REASON_REQUIRED" }, { status: 400 });
  const hold = body.legalHold;
  // Gate D2: the hold is written ONLY by message_archive_set_legal_hold() — the runtime role holds no UPDATE on its columns —
  // which also writes the audit row (who, the reason, before / after).
  if (!(await prisma.customer.findUnique({ where: { id }, select: { id: true } }))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [row] = await prisma.$queryRaw<{ hold: boolean }[]>`SELECT message_archive_set_legal_hold(${id}, ${hold}, ${user.id}, ${user.name ?? ""}, ${reason}) AS hold`;
  const r = row ? { messageLegalHold: row.hold } : null;
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ legalHold: r.messageLegalHold });
}

export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "customers.message_archive", { stepUp: true, message: ADMIN_ONLY });
  if (refused) return refused;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; reason?: unknown };
  if (body.action !== "erase") return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Unknown action." }, { status: 400 });
  const reason = reasonOf(body.reason);
  if (reason.length < 5) return NextResponse.json({ error: "اكتب السبب (5 أحرف على الأقل).", errorEn: "A reason of at least 5 characters is required.", code: "REASON_REQUIRED" }, { status: 400 });
  if (!(await prisma.customer.findUnique({ where: { id }, select: { id: true } }))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const [row] = await prisma.$queryRaw<{ erased: number }[]>`SELECT message_archive_erase_customer(${id}, ${user.id}, ${user.name ?? ""}, ${reason}) AS erased`;
    return NextResponse.json({ ok: true, erased: row?.erased ?? 0 });
  } catch (e) {
    if (/MESSAGE_ARCHIVE_LEGAL_HOLD/.test(String((e as Error)?.message ?? ""))) {
      return NextResponse.json({ error: "رسائل هذا العميل تحت حجز قانوني: ما تنحذف لين ينشال الحجز.", errorEn: "This customer's messages are under a legal hold.", code: "LEGAL_HOLD" }, { status: 409 });
    }
    throw e;
  }
}
