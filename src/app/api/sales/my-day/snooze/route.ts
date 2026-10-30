import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { riyadhDayStart } from "@/lib/services/sales/my-day/rules";

/**
 * «أجّل لبكرة» — POST /api/sales/my-day/snooze { customerId }: the customer leaves the caller's call list until Riyadh
 * midnight; DELETE ?customerId= brings it back. Per person (SalesCallSnooze), and only for a customer of the caller's
 * OWN book (accountOwnerId = caller) — anything else is 404, never a confirmation that the customer exists.
 */
async function ownCustomer(userId: string, customerId: unknown): Promise<string | null> {
  if (typeof customerId !== "string" || !customerId || customerId.length > 64) return null;
  const c = await prisma.customer.findFirst({ where: { id: customerId, accountOwnerId: userId }, select: { id: true } });
  return c?.id ?? null;
}

export async function POST(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) ?? {}; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    const id = await ownCustomer(user.id, body.customerId);
    if (!id) return NextResponse.json({ error: "Not found.", errorAr: "العميل غير موجود في عملائك." }, { status: 404 });
    const until = riyadhDayStart(new Date(), 1);
    await prisma.salesCallSnooze.upsert({
      where: { employeeId_customerId: { employeeId: user.id, customerId: id } },
      update: { until }, create: { employeeId: user.id, customerId: id, until },
    });
    return NextResponse.json({ customerId: id, until });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function DELETE(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  try {
    const id = await ownCustomer(user.id, new URL(request.url).searchParams.get("customerId"));
    if (!id) return NextResponse.json({ error: "Not found.", errorAr: "العميل غير موجود في عملائك." }, { status: 404 });
    await prisma.salesCallSnooze.deleteMany({ where: { employeeId: user.id, customerId: id } });
    return NextResponse.json({ customerId: id });
  } catch (err) {
    return handleDomainError(err);
  }
}
