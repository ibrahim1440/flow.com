import { parseLeadIdentity, leadCityFrom } from "@/lib/services/sales/lead-identity";
import { mergeAgainst, staleRefusal, versionRequired } from "@/lib/http/stale-record";
import { assertNotPast, sameRiyadhDay } from "@/lib/dates/not-past";
import { emailField, phoneField } from "@/lib/contact/phone";
import { NextResponse } from "@/lib/api-response";
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
        vatNumber: true, commercialRegNo: true, unifiedNumber: true, nationalBuildingNo: true, nationalStreet: true,
        nationalDistrict: true, nationalCity: true, nationalPostalCode: true, nationalAdditionalNo: true, nationalShortAddress: true,
        // The qualification answers gathered so far (20261204100000_pipeline_qualification).
        businessType: true, needSummary: true, expectedMonthlyKg: true, agreedNextStep: true,
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
            id: true, type: true, subject: true, body: true, dueAt: true, completedAt: true, outcome: true,
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
    // The full row: the field-level merge (gate E1) compares every field the form sends.
    const existing = await prisma.lead.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    const canAssign = seesAllSales(user.permissions);
    if (!canAssign && existing.ownerId !== user.id) {
      return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    }
    // P2 ERR-06 (gate E1): the form's version is required from the screens; a lead changed since the form opened merges
    // field by field — a field changed on both sides is a 409 naming it, nothing written.
    const noVersion = versionRequired(request, b.expectedUpdatedAt);
    if (noVersion) throw noVersion;
    const merged = mergeAgainst(b, { expected: b.expectedUpdatedAt, baseline: b.baseline, current: existing as unknown as Record<string, unknown> & { updatedAt: Date } });
    if (!merged.ok) throw merged.refusal;
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
    // A field sent with the value already stored (the same Riyadh day for the follow-up) is a no-op, not «nothing to change».
    let unchangedSent = false;
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
    // Optional since 20261221090000_lead_identity: "" clears it; a given name is ≥ 2 characters.
    if (b.contactName === null) data.contactName = null;
    else if (typeof b.contactName === "string") {
      const v = b.contactName.trim();
      if (v.length === 1) throw { _appCode: 400, message: "The contact name is too short." };
      data.contactName = v || null;
    }
    // The registration and national address: free on a lead (format checks only — services/sales/lead-identity.ts).
    const ident = parseLeadIdentity(b);
    if (!ident.ok) return NextResponse.json({ error: ident.errorAr, errorEn: ident.error, field: ident.field }, { status: 400 });
    Object.assign(data, ident.data);
    if ("nationalCity" in ident.data && typeof b.city !== "string") {
      const c = leadCityFrom(ident.data);
      if (c) data.city = c;
    }
    str("companyNameAr");
    // P1 ERR-04: the shared reader — canonical (+966…), cleared with "", a coded 400 when invalid.
    // Read only when CHANGED: an older stored value that fails the rules never blocks saving the other fields.
    if (b.phone !== undefined && (typeof b.phone !== "string" || b.phone.trim() !== (existing.phone ?? ""))) data.phone = phoneField(b.phone) ?? null;
    if (b.email !== undefined && (typeof b.email !== "string" || b.email.trim().toLowerCase() !== (existing.email ?? "").toLowerCase())) data.email = emailField(b.email) ?? null;
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
      assertNotPast(d, existing.nextFollowUpAt, "موعد المتابعة", "follow-up date"); // P2 ERR-15
      // Gate B2: the same Riyadh day sent back is no change — the stored follow-up (and its time) stays as it is.
      // Only a DATE (YYYY-MM-DD, what an edit form sends) on the same Riyadh day is «unchanged»; a full time is a choice.
      if (!(/^\d{4}-\d{2}-\d{2}$/.test(b.nextFollowUpAt) && sameRiyadhDay(d, existing.nextFollowUpAt))) data.nextFollowUpAt = d;
      else unchangedSent = true;
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
      // Everything the form sent was already changed by someone else and left alone by this form: nothing to write.
      if (merged.dropped.length || unchangedSent) {
        return NextResponse.json({ lead: { id: existing.id, companyName: existing.companyName, contactName: existing.contactName, phone: existing.phone, status: existing.status, ownerId: existing.ownerId, nextFollowUpAt: existing.nextFollowUpAt }, duplicates: [], merged: merged.dropped });
      }
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
          // P1 ERR-04: a phone cleared to null clears the key (it used to recompute it from the OLD phone).
          phone: data.phone !== undefined ? (data.phone as string | null) : existing.phone,
        }),
      );
    }

    // Atomic (gate E1): written only if the lead is still the version read above — a concurrent save that won first
    // makes this one a 409 rather than a silent overwrite.
    const written = await prisma.lead.updateMany({ where: { id, updatedAt: existing.updatedAt }, data });
    if (written.count === 0) throw staleRefusal(existing.updatedAt);
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, companyName: true, contactName: true, phone: true, status: true,
        ownerId: true, nextFollowUpAt: true,
      },
    });

    const weakDuplicates = await findDuplicateCandidates(prisma, {
      companyName: lead.companyName,
      phone: lead.phone,
      excludeLeadId: lead.id,
    }, user);

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
