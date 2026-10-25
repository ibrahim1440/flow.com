import { prisma } from "@/lib/db";

/**
 * A tracked link in a WhatsApp message: records the click as a touch (for attribution) and redirects
 * to the URL stored on the message. Never redirects to a URL from the request (no open redirect).
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await prisma.mktMessage.findUnique({ where: { id }, select: { id: true, phone: true, campaignId: true, trackedUrl: true } });
  if (!m?.trackedUrl) return new Response(null, { status: 404 });
  let target: URL;
  try { target = new URL(m.trackedUrl); } catch { return new Response(null, { status: 404 }); }
  if (target.protocol !== "https:") return new Response(null, { status: 404 });
  await prisma.mktTouch.create({ data: { subjectKey: m.phone, at: new Date(), channel: "WHATSAPP", campaignId: m.campaignId, messageId: m.id, detail: { kind: "click" } } }).catch(() => undefined);
  return Response.redirect(target.toString(), 302);
}
