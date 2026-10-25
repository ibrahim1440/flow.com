import { NextResponse } from "@/lib/api-response";
import { cloudConfig, verifyCloudSignature } from "@/lib/marketing/server/whatsapp-cloud";
import { applyCloudWebhook } from "@/lib/marketing/server/messaging";
import { prisma } from "@/lib/db";
import { sha256 } from "@/lib/marketing/server/crypto";
import { readCappedBody } from "@/lib/marketing/server/http";
import type { Prisma } from "@/generated/prisma/client";

/**
 * WhatsApp Cloud API webhook: GET is Meta's verification handshake (hub.verify_token), POST carries
 * message statuses and inbound messages, signed with X-Hub-Signature-256 over the raw body.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const cfg = cloudConfig();
  if (cfg.ok && cfg.config.verifyToken && q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === cfg.config.verifyToken) {
    return new Response(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(null, { status: 403 });
}

export async function POST(req: Request) {
  const raw = await readCappedBody(req, 2_000_000);
  if (raw === null) return new Response(null, { status: 413 });
  if (!verifyCloudSignature(raw, req.headers.get("x-hub-signature-256"))) return NextResponse.json({ error: "التوقيع غير صالح.", errorEn: "Invalid signature." }, { status: 401 });
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  const key = sha256(raw);
  const ev = await prisma.mktWebhookEvent.upsert({ where: { source_eventKey: { source: "WHATSAPP", eventKey: key } }, create: { source: "WHATSAPP", eventKey: key, signatureOk: true, payload: payload as Prisma.InputJsonValue }, update: {} });
  if (ev.status === "PROCESSED") return NextResponse.json({ ok: true, duplicate: true });
  const r = await applyCloudWebhook(payload);
  await prisma.mktWebhookEvent.update({ where: { id: ev.id }, data: { status: "PROCESSED", processedAt: new Date() } });
  return NextResponse.json({ ok: true, ...r });
}
