import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { normalizationFor, findDuplicateCandidates } from "@/lib/services/sales/leads";

type Params = { params: Promise<{ id: string }> };

const SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"];
const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "UNQUALIFIED"];

/** GET /api/sales/leads/[id] — one lead with its activity history. */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("sales");
  if (error) return error;
  const { id } = await params;

  try {
    const lead = await prisma.lead.findFirst({
      // Scoped in the WHERE clause. Fetching then checking is the same query with the leak
      // moved one line later.
      where: { id, ...(seesAllSales(user.permissions) ? {} : { ownerId: user.id }) },
      select: {
        id: true, companyName: true, companyNameAr: true, contactName: true,
        phone: true, email: true, city: true, address: true, source: true, sourceNote: true,
        status: true, notes: true, nextFollowUpAt: true, createdAt: true, updatedAt: true,
        owner: { select: { id: true, name: true } },
        conversion: {
          select: {
            customerId: true, opportunityId: true, customerCreated: true, convertedAt: true,
            customer: { select: { id: true, name: true } },
            opportunity: { select: { id: true, title: true, outcome: true } },
          },
        },
        activities: {
          orderBy: { createdAt: "desc" },
          take: 100,
          select: {
            id: true, type: true, subject: true, body: true, dueAt: true, completedAt: true,
            createdAt: true, owner: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!lead) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    return NextResponse.json({ lead });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/sales/leads/[id] — edit a lead.
 *
 * A converted lead is read-only. Its details became a Customer and an Opportunity; editing
 * the lead afterwards would leave two versions of the same company with no indication which
 * one the order was placed against.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
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
    const existing = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, ownerId: true, status: true, companyName: true, phone: true },
    });
    if (!existing) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const canAssign = seesAllSales(user.permissions);
    if (!canAssign && existing.ownerId !== user.id) {
      return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    }
    if (existing.status === "CONVERTED") {
      return NextResponse.json(
        {
          error:
            "This lead has been converted. Edit the customer or the deal it became; " +
            "changing the lead now would leave two versions of the same company.",
        },
        { status: 409 },
      );
    }

    const data: Record<string, unknown> = {};
    const str = (key: string, min = 0) => {
      if (typeof b[key] !== "string") return;
      const v = (b[key] as string).trim();
      if (min > 0 && v.length > 0 && v.length < min) {
        throw { _appCode: 400, message: `${key} is too short.` };
      }
      data[key] = v || null;
    };

    if (typeof b.companyName === "string") {
      const v = b.companyName.trim();
      if (v.length < 2) throw { _appCode: 400, message: "The company name is required." };
      data.companyName = v;
    }
    if (typeof b.contactName === "string") {
      const v = b.contactName.trim();
      if (v.length < 2) throw { _appCode: 400, message: "A contact name is required." };
      data.contactName = v;
    }
    str("companyNameAr");
    str("phone");
    str("email");
    str("city");
    str("address");
    str("sourceNote");
    str("notes");

    if (typeof b.source === "string") {
      if (!SOURCES.includes(b.source)) throw { _appCode: 400, message: "Unknown lead source." };
      data.source = b.source;
    }
    if (typeof b.status === "string") {
      // CONVERTED is not settable by hand: it is the consequence of a conversion, and a lead
      // marked converted with no LeadConversion row behind it breaks every conversion metric.
      if (!STATUSES.includes(b.status)) {
        throw {
          _appCode: 400,
          message: "A lead's status is one of: " + STATUSES.join(", ") + ". Converting is a separate action.",
        };
      }
      data.status = b.status;
    }
    if (b.nextFollowUpAt === null) {
      data.nextFollowUpAt = null;
    } else if (typeof b.nextFollowUpAt === "string" && b.nextFollowUpAt) {
      const d = new Date(b.nextFollowUpAt);
      if (Number.isNaN(d.getTime())) throw { _appCode: 400, message: "That follow-up date is not a date." };
      data.nextFollowUpAt = d;
    }

    // Reassignment is its own privilege, checked here and not inferred from the body.
    if (typeof b.ownerId === "string" && b.ownerId && b.ownerId !== existing.ownerId) {
      if (!canAssign) {
        throw { _appCode: 403, message: "Reassigning a lead needs the lead-assign permission." };
      }
      const target = await prisma.employee.findUnique({
        where: { id: b.ownerId },
        select: { id: true, active: true },
      });
      if (!target || !target.active) throw { _appCode: 400, message: "That employee cannot own a lead." };
      data.ownerId = b.ownerId;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    // The normalised duplicate keys are recomputed whenever either input changes, so an
    // edited phone number is findable. Stale keys are worse than none: they claim a match
    // that no longer exists.
    if (data.companyName !== undefined || data.phone !== undefined) {
      Object.assign(
        data,
        normalizationFor({
          companyName: (data.companyName as string) ?? existing.companyName,
          phone: (data.phone as string | null) ?? existing.phone,
        }),
      );
    }

    const lead = await prisma.lead.update({
      where: { id },
      data,
      select: {
        id: true, companyName: true, contactName: true, phone: true, status: true,
        ownerId: true, nextFollowUpAt: true,
      },
    });

    const weakDuplicates = await findDuplicateCandidates(prisma, {
      companyName: lead.companyName,
      phone: lead.phone,
      excludeLeadId: lead.id,
    });

    return NextResponse.json({ lead, duplicates: weakDuplicates });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * DELETE /api/sales/leads/[id] — remove a lead that should never have been recorded.
 *
 * Refused once it has been converted or has any history: the customer, the deal and the
 * calls that were logged against it all point here, and a CRM that lets a rep delete the
 * record of a conversation is a CRM with no audit trail. Marking it UNQUALIFIED is the
 * ordinary way to retire a lead.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  const { id } = await params;

  try {
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true, ownerId: true, status: true,
        conversion: { select: { leadId: true } },
        _count: { select: { activities: true } },
      },
    });
    if (!lead) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    if (!seesAllSales(user.permissions) && lead.ownerId !== user.id) {
      return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    }
    if (lead.conversion) {
      return NextResponse.json(
        { error: "This lead became a customer and a deal. It cannot be deleted." },
        { status: 409 },
      );
    }
    if (lead._count.activities > 0) {
      return NextResponse.json(
        {
          error:
            `This lead has ${lead._count.activities} logged activities. Mark it unqualified ` +
            "instead of deleting the record of those conversations.",
        },
        { status: 409 },
      );
    }

    await prisma.lead.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}
