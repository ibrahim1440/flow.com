import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { handlePrismaError } from "@/lib/api-error";

const CONFIRM_PHRASE = "RESET HIQBAH";

export async function POST(request: Request) {
  try {
    const ip = extractIp(request);

    // Layer 1: must have settings.reset sub-privilege (admins only)
    const { user, error } = await requireSub("settings", "reset");
    if (error) return error;

    const ipHash = hashRateLimitKey(ip);
    const identifierHash = hashRateLimitKey("reset:" + user.id);
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 10)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (await isPairRateLimited(ipHash, identifierHash, 5)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }

    const { phrase, pin } = await request.json();

    // Layer 2: confirmation phrase must match exactly
    if (phrase !== CONFIRM_PHRASE) {
      return NextResponse.json({ error: "Confirmation phrase is incorrect" }, { status: 400 });
    }

    // Layer 3: admin must re-verify their PIN
    const admin = await prisma.employee.findUnique({ where: { id: user.id } });
    if (!admin || !(await compare(pin, admin.pin))) {
      await recordFailedAttempt(ipHash, identifierHash);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    await clearAttempts(ipHash, identifierHash);

    // Atomic deletion in FK-safe order.
    // Preserved: Employee, Supplier, CoffeeProduct, ProductSKU, SystemConfig.
    // BlendIngredient cascades from RoastingBatch but is deleted explicitly for clarity.
    await prisma.$transaction([
      prisma.cuppingScore.deleteMany(),
      prisma.cuppingSessionBatch.deleteMany(),
      prisma.cuppingSession.deleteMany(),
      prisma.inventoryMovement.deleteMany(),
      // Must precede finishedGoodsLot: StockAllocation.finishedGoodsLotId is ON DELETE
      // RESTRICT, so leaving these behind makes the whole reset transaction fail.
      prisma.stockAllocation.deleteMany(),
      prisma.finishedGoodsLot.deleteMany(),
      prisma.productionOrder.deleteMany(),
      prisma.purchaseRecord.deleteMany(),
      prisma.qcRecord.deleteMany(),
      prisma.delivery.deleteMany(),
      prisma.blendIngredient.deleteMany(),
      prisma.roastingBatch.deleteMany(),
      prisma.orderItem.deleteMany(),
      prisma.order.deleteMany(),
      prisma.customer.deleteMany(),
      prisma.greenBean.deleteMany(),
    ]);

    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
