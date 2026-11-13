import { parseLeadIdentity, leadCityFrom } from "@/lib/services/sales/lead-identity";
import { isPastDay, pastDateRefusal } from "@/lib/dates/not-past";
import { emailField, phoneField, phoneSearchKey } from "@/lib/contact/phone";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { normalizationFor, findDuplicateCandidates, normalizePhone } from "@/lib/services/sales/leads";
import { customerInScope } from "@/lib/services/sales/customer-access";

/**
 * GET /api/sales/leads — the lead list, scoped to what the caller may see.
 *
 * Scoping happens in the WHERE clause, never by filtering after the fetch. Sending rows a
 * user may not see and hiding them in the browser is not access control; it is a leak with
 * a stylesheet over it.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const status = url.searchParams.get("status");
  const ownerFilter = url.searchParams.get("owner");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage") ?? 25) || 25));

  // A rep sees their own leads. Seeing the whole pipeline is its own privilege, because
  // the customer list is the commercially sensitive part of a sales system.
  const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");

  try {
    // OPEN and CLOSED are the two groups of the list's tabs (`crm-leads`): still being worked,
    // and finished one way or the other. Any other value is a single stored status.
    const statusWhere = status === "OPEN" ? { status: { in: OPEN_STATUSES as never } }
      : status === "CLOSED" ? { status: { in: CLOSED_STATUSES as never } }
      : status ? { status: status as never } : {};
    const scopeWhere = {
      ...(seesAll ? (ownerFilter ? { ownerId: ownerFilter } : {}) : { ownerId: user.id }),
      ...(q
        ? {
            OR: [
              { companyName: { contains: q, mode: "insensitive" as const } },
              { contactName: { contains: q, mode: "insensitive" as const } },
              // P2 ERR-16: the last digits (canonical +966… numbers), and the raw text for a value the phone cleanup could not read.
              ...(phoneSearchKey(q) ? [{ phone: { contains: phoneSearchKey(q)! } }, { phone: { contains: q } }] : []),
              { city: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    const where = { ...scopeWhere, ...statusWhere };
    const now = new Date();

    const [rows, total, byStatus, overdue, noCommitment, ownerRows] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: [{ nextFollowUpAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true, companyName: true, companyNameAr: true, contactName: true,
          phone: true, email: true, city: true, source: true, status: true,
          nextFollowUpAt: true, createdAt: true,
          owner: { select: { id: true, name: true } },
          conversion: { select: { customerId: true, opportunityId: true } },
        },
      }),
      prisma.lead.count({ where }),
      // The tab counts and the header's two urgency counts, over everything the search and
      // owner filter match — not just the page on screen.
      prisma.lead.groupBy({ by: ["status"], where: scopeWhere, _count: { _all: true } }),
      prisma.lead.count({ where: { ...scopeWhere, status: { in: OPEN_STATUSES as never }, nextFollowUpAt: { lt: now } } }),
      prisma.lead.count({ where: { ...scopeWhere, status: { in: OPEN_STATUSES as never }, nextFollowUpAt: null } }),
      // The owner filter's choices: the people who own leads this viewer may see.
      seesAll
        ? prisma.lead.findMany({ distinct: ["ownerId"], select: { owner: { select: { id: true, name: true } } } })
        : Promise.resolve([] as { owner: { id: string; name: string } }[]),
    ]);
    const counts: Record<string, number> = { OPEN: 0, CLOSED: 0 };
    for (const g of byStatus) {
      counts[g.status] = g._count._all;
      if ((OPEN_STATUSES as string[]).includes(g.status)) counts.OPEN += g._count._all;
      else counts.CLOSED += g._count._all;
    }

    return NextResponse.json({
      rows,
      page,
      perPage,
      total,
      counts,
      owners: ownerRows.map((r) => r.owner),
      overdue,
      noCommitment,
      // Stated so the screen can tell an operator they are looking at their own leads
      // rather than leaving them to wonder where everyone else's went.
      scope: seesAll ? "all" : "own",
    });
  } catch (err) {
    // A coded refusal (P1 ERR-04: PHONE_INVALID / EMAIL_INVALID) keeps its 400; anything else as before.
    return handleDomainError(err);
  }
}

const OPEN_STATUSES = ["NEW", "CONTACTED", "QUALIFIED"];
const CLOSED_STATUSES = ["UNQUALIFIED", "CONVERTED"];

/** POST /api/sales/leads — create a lead. */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const companyName = typeof b.companyName === "string" ? b.companyName.trim() : "";
  const contactName = typeof b.contactName === "string" ? b.contactName.trim() : "";
  if (companyName.length < 2) {
    return NextResponse.json({ error: "The company name is required." }, { status: 400 });
  }
  // The contact person is optional (owner, Figma page 12: only «اسم المنشأة» is required); a given one is ≥ 2 characters.
  if (contactName && contactName.length < 2) {
    return NextResponse.json({ error: "The contact name is too short.", errorAr: "اسم الشخص المسؤول قصير." }, { status: 400 });
  }
  // The customer's registration and national address, same formats as the customer form (services/sales/lead-identity.ts).
  const ident = parseLeadIdentity(b);
  if (!ident.ok) return NextResponse.json({ error: ident.errorAr, errorEn: ident.error, field: ident.field }, { status: 400 });

  const SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"];
  const source = typeof b.source === "string" && SOURCES.includes(b.source) ? b.source : "OTHER";

  // Ownership is NOT client-controlled unless the caller may assign. Accepting ownerId from
  // the body without this check is the classic mass-assignment hole: a rep could plant a
  // lead on a colleague, or take one, and the commission would follow.
  const canAssign = hasSubPrivilege(user.permissions, "sales", "lead_assign");
  const ownerId = canAssign && typeof b.ownerId === "string" && b.ownerId ? b.ownerId : user.id;

  try {
    // P1 ERR-04: one reader of the typed phone / e-mail (lib/contact/phone.ts) — stored canonical (+966…), or a coded 400.
    const phone = phoneField(b.phone) ?? null;
    const email = emailField(b.email) ?? null;
    if (canAssign && ownerId !== user.id) {
      const target = await prisma.employee.findUnique({ where: { id: ownerId }, select: { id: true, active: true } });
      if (!target || !target.active) {
        return NextResponse.json({ error: "That employee cannot own a lead." }, { status: 400 });
      }
    }

    // D17 «وش طلع من الجولة؟ › أضف عميل محتمل»: the field round (in the caller's own plan) the lead was found on.
    const fieldRoundItemId = typeof b.fieldRoundItemId === "string" && b.fieldRoundItemId ? b.fieldRoundItemId : null;
    if (fieldRoundItemId) {
      const round = await prisma.salesPlanItem.findUnique({ where: { id: fieldRoundItemId }, select: { employeeId: true, category: true } });
      if (!round || round.employeeId !== user.id || round.category !== "FIELD_ROUND") {
        return NextResponse.json({ error: "The field round was not found." }, { status: 400 });
      }
    }

    const norm = normalizationFor({ companyName, phone });

    // Duplicates are reported, never merged and never silently blocked. Several buyers at
    // one café is the normal case; one handset appearing twice is worth a second look.
    const candidates = await findDuplicateCandidates(prisma, {
      companyName,
      phone,
    }, user);
    const strong = candidates.filter((c) => c.strong);
    // D17 (Abu Fahd): a shop met on a field round may already be a CUSTOMER — the same phone (normalised) stops the add
    // until confirmed. A customer outside the caller's book is reported without its name or id. The expression is EXACTLY
    // the one of "Customer_phone_last9_idx" (20261227090000) so the lookup uses the index; phoneKey is already the last 9 digits.
    const phoneKey = fieldRoundItemId ? normalizePhone(phone) : null;
    if (phoneKey && b.acknowledgeDuplicate !== true) {
      const hits = await prisma.$queryRaw<{ id: string; name: string; nameAr: string | null }[]>`
        SELECT id, name, "nameAr" FROM "Customer"
         WHERE "phone" IS NOT NULL AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ${phoneKey} LIMIT 5`;
      if (hits.length) {
        const customers = await Promise.all(hits.map(async (c) => ((await customerInScope(user, c.id)) ? { id: c.id, name: c.nameAr ?? c.name } : { id: null, name: null })));
        return NextResponse.json({ error: "A customer with this phone number already exists.", customers, duplicates: strong }, { status: 409 });
      }
    }
    if (strong.length > 0 && b.acknowledgeDuplicate !== true) {
      return NextResponse.json(
        {
          error: "A lead with this phone number already exists.",
          duplicates: strong,
          // The caller may proceed deliberately; it cannot happen by accident.
          resolution: "Resend with acknowledgeDuplicate: true to create it anyway, or open the existing lead.",
        },
        { status: 409 },
      );
    }

    const followUp = typeof b.nextFollowUpAt === "string" && b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null;
    if (followUp && Number.isNaN(followUp.getTime())) {
      return NextResponse.json({ error: "موعد المتابعة غير صالح.", errorEn: "nextFollowUpAt is not a date." }, { status: 400 });
    }
    // P2 ERR-15: a new lead's first follow-up is today or later.
    if (followUp && isPastDay(followUp)) {
      const r = pastDateRefusal("موعد المتابعة", "follow-up date");
      return NextResponse.json({ error: r.errorAr, errorEn: r.errorEn, code: r.code, field: "nextFollowUpAt" }, { status: 400 });
    }

    // With a first follow-up, the promise is a TASK activity in the same transaction — the lead's
    // `nextFollowUpAt` alone says "when" but not "who promised what" (services/sales/follow-up.ts),
    // and it is the activity that appears on the owner's «مساحة عملي».
    const lead = await prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          companyName,
          companyNameAr: typeof b.companyNameAr === "string" ? b.companyNameAr.trim() || null : null,
          contactName: contactName || null,
          phone,
          email,
          city: (typeof b.city === "string" ? b.city.trim() || null : null) ?? leadCityFrom(ident.data),
          ...ident.data,
          address: typeof b.address === "string" ? b.address.trim() || null : null,
          source: source as never,
          sourceNote: typeof b.sourceNote === "string" ? b.sourceNote.trim() || null : null,
          notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
          nextFollowUpAt: followUp,
          fieldRoundItemId,
          ownerId,
          createdById: user.id,
          ...norm,
        },
        select: { id: true, companyName: true, contactName: true, status: true, ownerId: true },
      });
      if (followUp) {
        await tx.activity.create({
          data: { type: "TASK", subject: `متابعة ${companyName}`, leadId: created.id, dueAt: followUp, ownerId },
        });
      }
      return created;
    });

    return NextResponse.json({ lead, weakDuplicates: candidates.filter((c) => !c.strong) }, { status: 201 });
  } catch (err) {
    // A coded refusal (P1 ERR-04: PHONE_INVALID / EMAIL_INVALID) keeps its 400; anything else as before.
    return handleDomainError(err);
  }
}
