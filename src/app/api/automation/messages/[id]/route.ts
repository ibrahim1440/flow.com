import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { actOnMessage } from "@/lib/automation/rule-service";
import { requestAutomationDispatch } from "@/lib/automation/emit";

type Params = { params: Promise<{ id: string }> };

/** { action: "retry" | "cancel" } */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("automation", "manage_messages");
  if (error) return error;
  const { id } = await params;

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "retry" && body.action !== "cancel") {
    return NextResponse.json({ error: "action must be retry or cancel." }, { status: 400 });
  }
  const action = body.action;

  try {
    await prisma.$transaction((tx) => actOnMessage(tx, id, action, user.name));
    if (action === "retry") requestAutomationDispatch();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleDomainError(err);
  }
}
