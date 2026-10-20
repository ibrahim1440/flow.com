import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { cleanGuestName, createQcInvite, ensureGuestToken } from "@/lib/services/qc-invite";

type Params = { params: Promise<{ batchId: string }> };

/** The origin guests open the link on: the deployment's public host, as the request reached it. */
function originOf(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/**
 * POST /api/qc/[batchId]/invite — invite a guest evaluator (owner decision D4: qc › manage only).
 *
 * Body (all optional, so the legacy «copy guest link» call keeps working):
 *   { channel: "present" | "link", name, phone? }
 * Without a name: returns the batch's guest token only, as before. With a name: records a QcInvite
 * (PENDING until that guest's evaluation arrives); a "link" invite with a phone is queued as a
 * WhatsApp message under the automation sending mode (src/lib/services/qc-invite.ts).
 * Response: { token, batchId, url, invite?, whatsapp? }.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("qc", "manage");
  if (error) return error;

  const { batchId } = await params;
  let body: Record<string, unknown> = {};
  try { body = ((await request.json()) as Record<string, unknown>) ?? {}; } catch { body = {}; }

  const channelRaw = typeof body.channel === "string" ? body.channel.toLowerCase() : null;
  if (channelRaw !== null && channelRaw !== "present" && channelRaw !== "link") {
    return NextResponse.json({ error: "channel must be present or link." }, { status: 400 });
  }
  const hasName = body.name !== undefined && body.name !== null && body.name !== "";
  const name = hasName ? cleanGuestName(body.name) : null;
  if (hasName && !name) return NextResponse.json({ error: "اكتب اسم الضيف (حتى 120 حرفًا).", errorEn: "The guest's name is 1–120 characters.", code: "INVALID_NAME" }, { status: 400 });
  if (channelRaw && !name) return NextResponse.json({ error: "اكتب اسم الضيف.", errorEn: "An invitation needs the guest's name.", code: "INVALID_NAME" }, { status: 400 });
  const phone = typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  if (phone && channelRaw !== "link") return NextResponse.json({ error: "A phone is sent with a link invitation only." }, { status: 400 });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string; qcToken: string | null }[]>`
        SELECT "id", "status", "qcToken" FROM "RoastingBatch" WHERE "id" = ${batchId} FOR UPDATE`;
      const batch = locked[0];
      if (!batch) throw { _appCode: 404, message: "Batch not found" };
      if (batch.status !== "Pending QC") throw { _appCode: 409, message: "Batch is no longer open for QC" };
      const origin = originOf(request);
      if (!name) {
        const token = await ensureGuestToken(tx, batch);
        return { token, batchId, url: `${origin}/guest-qc/${batchId}/${token}` };
      }
      const r = await createQcInvite(tx, { batch, channel: channelRaw === "present" ? "PRESENT" : "LINK", name, phone, origin, actorId: user.id });
      return { token: r.token, batchId, url: r.url, invite: r.invite, whatsapp: r.whatsapp };
    }, TX_OPTS);
    return NextResponse.json(result, { status: name ? 201 : 200 });
  } catch (err) {
    return handleDomainError(err);
  }
}
