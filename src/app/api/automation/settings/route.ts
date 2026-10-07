import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { liveAllowed, SETTINGS_ID, type SendMode } from "@/lib/automation/settings";

const MODES: SendMode[] = ["OFF", "TEST", "LIVE"];

/** { sendMode: "OFF" | "TEST" | "LIVE", testPhone?: string } */
export async function PUT(request: Request) {
  const { user, error } = await requireSub("automation", "manage_connection");
  if (error) return error;

  let body: { sendMode?: unknown; testPhone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const sendMode = body.sendMode as SendMode;
  if (!MODES.includes(sendMode)) return NextResponse.json({ error: "sendMode must be OFF, TEST or LIVE." }, { status: 400 });

  let testPhone: string | null = null;
  if (typeof body.testPhone === "string" && body.testPhone.trim()) {
    const p = normalizePhoneForWhatsApp(body.testPhone);
    if (!p.ok) return NextResponse.json({ error: `Test number: ${p.reason}` }, { status: 400 });
    testPhone = p.phone;
  }
  if (sendMode === "TEST" && !testPhone) {
    return NextResponse.json({ error: "Test mode needs a test number." }, { status: 400 });
  }
  if (sendMode === "LIVE" && !liveAllowed()) {
    return NextResponse.json(
      { error: "Live sending is not enabled on this deployment. Set WHATSAPP_LIVE_ENABLED=true on the server first." },
      { status: 409 },
    );
  }

  const row = await prisma.automationSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, sendMode, testPhone, updatedById: user.id },
    update: { sendMode, testPhone, updatedById: user.id },
  });
  return NextResponse.json({ sendMode: row.sendMode, testPhone: row.testPhone });
}
