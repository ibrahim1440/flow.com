import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { normalizationFor, findDuplicateCandidates } from "@/lib/services/sales/leads";

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
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage") ?? 25) || 25));

  // A rep sees their own leads. Seeing the whole pipeline is its own privilege, because
  // the customer list is the commercially sensitive part of a sales system.
  const seesAll = hasSubPrivilege(user.permissions, "sales", "lead_assign");

  try {
    const where = {
      ...(seesAll ? {} : { ownerId: user.id }),
      ...(status ? { status: status as never } : {}),
      ...(q
        ? {
            OR: [
              { companyName: { contains: q, mode: "insensitive" as const } },
              { contactName: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q } },
              { city: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
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
    ]);

    return NextResponse.json({
      rows,
      page,
      perPage,
      total,
      // Stated so the screen can tell an operator they are looking at their own leads
      // rather than leaving them to wonder where everyone else's went.
      scope: seesAll ? "all" : "own",
    });
  } catch (err) {
    return handlePrismaError(err);
  }
}

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
  if (contactName.length < 2) {
    return NextResponse.json({ error: "A contact name is required." }, { status: 400 });
  }

  const SOURCES = ["WALK_IN", "REFERRAL", "PHONE", "SOCIAL", "EXHIBITION", "WEBSITE", "OTHER"];
  const source = typeof b.source === "string" && SOURCES.includes(b.source) ? b.source : "OTHER";

  // Ownership is NOT client-controlled unless the caller may assign. Accepting ownerId from
  // the body without this check is the classic mass-assignment hole: a rep could plant a
  // lead on a colleague, or take one, and the commission would follow.
  const canAssign = hasSubPrivilege(user.permissions, "sales", "lead_assign");
  const ownerId = canAssign && typeof b.ownerId === "string" && b.ownerId ? b.ownerId : user.id;

  try {
    if (canAssign && ownerId !== user.id) {
      const target = await prisma.employee.findUnique({ where: { id: ownerId }, select: { id: true, active: true } });
      if (!target || !target.active) {
        return NextResponse.json({ error: "That employee cannot own a lead." }, { status: 400 });
      }
    }

    const norm = normalizationFor({ companyName, phone: b.phone as string | null });

    // Duplicates are reported, never merged and never silently blocked. Several buyers at
    // one café is the normal case; one handset appearing twice is worth a second look.
    const candidates = await findDuplicateCandidates(prisma, {
      companyName,
      phone: b.phone as string | null,
    });
    const strong = candidates.filter((c) => c.strong);
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

    const lead = await prisma.lead.create({
      data: {
        companyName,
        companyNameAr: typeof b.companyNameAr === "string" ? b.companyNameAr.trim() || null : null,
        contactName,
        phone: typeof b.phone === "string" ? b.phone.trim() || null : null,
        email: typeof b.email === "string" ? b.email.trim() || null : null,
        city: typeof b.city === "string" ? b.city.trim() || null : null,
        address: typeof b.address === "string" ? b.address.trim() || null : null,
        source: source as never,
        sourceNote: typeof b.sourceNote === "string" ? b.sourceNote.trim() || null : null,
        notes: typeof b.notes === "string" ? b.notes.trim() || null : null,
        nextFollowUpAt: typeof b.nextFollowUpAt === "string" ? new Date(b.nextFollowUpAt) : null,
        ownerId,
        createdById: user.id,
        ...norm,
      },
      select: { id: true, companyName: true, contactName: true, status: true, ownerId: true },
    });

    return NextResponse.json({ lead, weakDuplicates: candidates.filter((c) => !c.strong) }, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
