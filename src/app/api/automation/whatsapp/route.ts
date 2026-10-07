import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";
import { connect, getConnectionState, logout, restart, sendText, whatsappConfig } from "@/lib/whatsapp/evolution";
import { normalizePhoneForWhatsApp } from "@/lib/automation/phone";
import { effectiveMode, liveAllowed, readSettings } from "@/lib/automation/settings";

/** The connection, the sending mode, and how the queue stands. */
export async function GET() {
  const { error } = await requireModule("automation");
  if (error) return error;

  const cfg = whatsappConfig();
  const [settings, queued, failed24h, sent24h] = await Promise.all([
    readSettings(),
    prisma.whatsAppMessage.count({ where: { status: "QUEUED" } }),
    prisma.whatsAppMessage.count({ where: { status: "FAILED", updatedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.whatsAppMessage.count({ where: { status: "SENT", sentAt: { gte: new Date(Date.now() - 86_400_000) } } }),
  ]);
  const state = cfg.ok ? await getConnectionState() : null;
  const effective = effectiveMode(settings);

  return NextResponse.json({
    configured: cfg.ok,
    configError: cfg.ok ? null : cfg.reason,
    state: state?.ok ? state.state : null,
    stateError: state && !state.ok ? state.error : null,
    sendMode: settings.sendMode,
    testPhone: settings.testPhone,
    liveAllowed: liveAllowed(),
    effectiveMode: effective.mode,
    effectiveNote: effective.mode === "OFF" ? effective.note : null,
    queue: { queued, failed24h, sent24h },
  });
}

const ACTIONS = ["qr", "pair", "logout", "restart", "test"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * { action: "qr" }                     → a QR image to scan (expires in about a minute)
 * { action: "pair", number }           → a pairing code to type into WhatsApp on that phone
 * { action: "logout" }                 → unlink the current phone
 * { action: "restart" }                → restart a stuck connection
 * { action: "test", phone?, text? }    → send one message now (to the test number by default)
 *
 * There is deliberately no action that deletes the instance.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("automation", "manage_connection");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = body.action as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const cfg = whatsappConfig();
  if (!cfg.ok) return NextResponse.json({ error: cfg.reason }, { status: 503 });

  // The QR screen polls every ~30 s while open; this leaves room for that and stops a stuck
  // tab or a script from hammering the WhatsApp server.
  const { limited } = await checkAndRecordRateLimit({
    scope: action === "test" ? "automation:test" : "automation:connection",
    key: user.id,
    limit: action === "test" ? 10 : 60,
    windowMs: 10 * 60 * 1000,
  });
  if (limited) return NextResponse.json({ error: "Too many requests. Wait a few minutes." }, { status: 429 });

  if (action === "qr") {
    const r = await connect();
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    return NextResponse.json(r);
  }

  if (action === "pair") {
    const phone = normalizePhoneForWhatsApp(typeof body.number === "string" ? body.number : "");
    if (!phone.ok) return NextResponse.json({ error: phone.reason }, { status: 400 });
    const r = await connect(phone.phone);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    return NextResponse.json(r);
  }

  if (action === "logout") {
    const r = await logout();
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    return NextResponse.json({ ok: true });
  }

  if (action === "restart") {
    const r = await restart();
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    return NextResponse.json({ ok: true });
  }

  // ── test ──
  const settings = await readSettings();
  const target = normalizePhoneForWhatsApp(
    typeof body.phone === "string" && body.phone.trim() ? body.phone : settings.testPhone,
  );
  if (!target.ok) return NextResponse.json({ error: `Test number: ${target.reason}` }, { status: 400 });
  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text.trim().slice(0, 1000)
      : `رسالة تجريبية من نظام حقبة. أرسلها ${user.name}.`;

  const state = await getConnectionState();
  if (!state.ok) return NextResponse.json({ error: state.error }, { status: 502 });
  if (state.state !== "open") {
    return NextResponse.json({ error: `WhatsApp is not connected (state: ${state.state}).` }, { status: 409 });
  }

  const started = Date.now();
  const result = await sendText(target.phone, text);
  await prisma.whatsAppMessage.create({
    data: {
      dedupeKey: `test:${randomUUID()}`,
      recipientKind: "test",
      recipientName: user.name,
      phone: target.phone,
      body: text,
      status: result.ok ? "SENT" : "FAILED",
      statusNote: result.ok ? "Test message." : result.error,
      attempts: 1,
      sentAt: result.ok ? new Date() : null,
      providerMessageId: result.ok ? result.messageId : null,
      createdById: user.id,
      sendAttempts: {
        create: { attemptNo: 1, ok: result.ok, httpStatus: result.ok ? 200 : result.status, error: result.ok ? null : result.error, durationMs: Date.now() - started },
      },
    },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, phone: target.phone });
}
