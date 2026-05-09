import { NextResponse } from "next/server";
import { compareSync } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";

const CONFIRM_PHRASE = "RESET HIQBAH";

export async function POST(request: Request) {
  try {
    // Layer 1: must have settings.reset sub-privilege (admins only)
    const { user, error } = await requireSub("settings", "reset");
    if (error) return error;

    const { phrase, pin } = await request.json();

    // Layer 2: confirmation phrase must match exactly
    if (phrase !== CONFIRM_PHRASE) {
      return NextResponse.json({ error: "Confirmation phrase is incorrect" }, { status: 400 });
    }

    // Layer 3: admin must re-verify their PIN
    const admin = await prisma.employee.findUnique({ where: { id: user.id } });
    if (!admin || !compareSync(pin, admin.pin)) {
      return NextResponse.json({ error: "Invalid PIN" }, { status: 401 });
    }

    // Atomic deletion in FK-safe order — Employee table is NEVER touched
    await prisma.$transaction([
      prisma.qcRecord.deleteMany(),
      prisma.delivery.deleteMany(),
      prisma.roastingBatch.deleteMany(),
      prisma.orderItem.deleteMany(),
      prisma.order.deleteMany(),
      prisma.customer.deleteMany(),
      prisma.greenBean.deleteMany(),
      prisma.coffeeProduct.deleteMany(),
    ]);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[POST /api/admin/reset] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      { status: 500 }
    );
  }
}
