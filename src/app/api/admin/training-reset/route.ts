import { NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { handlePrismaError } from "@/lib/api-error";

const CONFIRM_PHRASE = "CLEAR DEMO DATA";

export async function POST(request: Request) {
  try {
    const ip = extractIp(request);

    // Layer 1: settings.training_reset sub-privilege required (admin only by default)
    const { user, error } = await requireSub("settings", "training_reset");
    if (error) return error;

    const ipHash = hashRateLimitKey(ip);
    const identifierHash = hashRateLimitKey("training-reset:" + user.id);
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

    // Layer 3: admin PIN re-verify
    const admin = await prisma.employee.findUnique({ where: { id: user.id } });
    if (!admin || !(await compare(pin, admin.pin))) {
      await recordFailedAttempt(ipHash, identifierHash);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    await clearAttempts(ipHash, identifierHash);

    // FK-safe deletion in order.
    // Extends production reset scope by also deleting catalog/master data:
    // ProductSKU (before CoffeeProduct), CoffeeProduct, Supplier.
    // Preserved: Employee, SystemConfig, LoginAttempt, RateLimit.
    // CustomerRoastPreference cascades from Customer (onDelete: Cascade) — no explicit delete needed.
    // CoffeeProduct.defaultGreenBeanId is nullable — SET NULL applied when GreenBean is deleted.
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
      prisma.productSKU.deleteMany(),
      prisma.coffeeProduct.deleteMany(),
      prisma.supplier.deleteMany(),
    ]);

    return NextResponse.json({ success: true, message: "Training data reset completed successfully." });
  } catch (err) {
    return handlePrismaError(err);
  }
}
