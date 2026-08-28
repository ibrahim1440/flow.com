import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { appendOrderActivity, isNoteDepartment, NOTE_MESSAGE_MAX_LENGTH } from "@/lib/services/order-operations";

type Params = { params: Promise<{ id: string }> };

// Manual notes only append MANUAL_NOTE activity rows — no status side effect,
// and no edit/delete route exists for OrderActivity by design (append-only).
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireModule("orders");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { department, message } = (body ?? {}) as { department?: unknown; message?: unknown };

  // Department is never trusted as free text from the browser — validated against
  // a fixed allowlist only.
  if (!isNoteDepartment(department)) {
    return NextResponse.json(
      { error: "department must be one of: Sales, Online, Preparation, Production, Operations, Shipping." },
      { status: 400 }
    );
  }

  const trimmedMessage = typeof message === "string" ? message.trim() : "";
  if (!trimmedMessage) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }
  if (trimmedMessage.length > NOTE_MESSAGE_MAX_LENGTH) {
    return NextResponse.json(
      { error: `message must be at most ${NOTE_MESSAGE_MAX_LENGTH} characters.` },
      { status: 400 }
    );
  }

  try {
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) {
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }

    const activity = await prisma.$transaction((tx) =>
      appendOrderActivity(tx, {
        orderId: id,
        type: "MANUAL_NOTE",
        message: trimmedMessage,
        department,
        authorId: user.id,
        authorName: user.name,
      })
    );

    return NextResponse.json(
      {
        id: activity.id,
        type: activity.type,
        message: activity.message,
        department: activity.department,
        authorId: activity.authorId,
        authorName: activity.authorName,
        createdAt: activity.createdAt,
      },
      { status: 201 }
    );
  } catch (err) {
    return handlePrismaError(err);
  }
}
