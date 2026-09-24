import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { convertLead } from "@/lib/services/sales/leads";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/leads/[id]/convert — turn a qualified lead into a customer and a deal.
 *
 * Idempotent. This is the button people double-click, and the cost of getting it wrong is a
 * duplicate customer plus a duplicate deal, which somebody then has to unpick by hand. The
 * service takes the lead row FOR UPDATE and LeadConversion is unique on leadId, so the
 * second request reads what the first committed instead of racing it.
 *
 * Reuses the existing Customer and the existing Opportunity — it creates no parallel
 * customer system.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_convert");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    // Ownership is checked before anything else. A rep who may convert may only convert
    // their OWN lead; reaching another rep's lead by changing the id in the URL is the
    // first thing anybody tries.
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });
    if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });

    const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");
    if (!seesAll && lead.ownerId !== user.id) {
      // Deliberately 404, not 403: confirming the row exists would tell an unauthorised
      // caller that a lead with that id is somebody else's.
      return NextResponse.json({ error: "Lead not found." }, { status: 404 });
    }

    // The stage must exist and be active, and it is resolved server-side — a caller cannot
    // drop a new deal straight into a terminal-looking stage of its choosing.
    const stageId = typeof b.stageId === "string" ? b.stageId : null;
    const stage = stageId
      ? await prisma.pipelineStage.findFirst({ where: { id: stageId, isActive: true }, select: { id: true } })
      : await prisma.pipelineStage.findFirst({ where: { isActive: true }, orderBy: { position: "asc" }, select: { id: true } });
    if (!stage) {
      return NextResponse.json(
        { error: "No active pipeline stage is configured. Configure the pipeline first." },
        { status: 409 },
      );
    }

    const result = await prisma.$transaction(
      (tx) =>
        convertLead(tx, {
          leadId: id,
          linkToCustomerId: typeof b.linkToCustomerId === "string" ? b.linkToCustomerId : null,
          stageId: stage.id,
          title: typeof b.title === "string" ? b.title : undefined,
          expectedCloseAt: typeof b.expectedCloseAt === "string" ? new Date(b.expectedCloseAt) : null,
          actorId: user.id,
        }),
      TX_OPTS,
    );

    // A replay answers 200 rather than 201: nothing was created this time, and saying
    // otherwise would make a retry look like a second conversion.
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}
