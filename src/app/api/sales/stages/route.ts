import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";

/**
 * Pipeline stages — the columns of the board, as configuration rather than as a constant
 * in the client.
 *
 * `code` is the stable identity and never changes; `nameEn` / `nameAr` are labels and may.
 * A board whose columns are hard-coded English strings cannot be renamed for an Arabic
 * roastery without a deployment, and cannot be reordered at all.
 */

/** GET /api/sales/stages — the configured stages, with how many deals sit in each. */
export async function GET(request: Request) {
  const { error } = await requireModule("sales");
  if (error) return error;

  const includeInactive = new URL(request.url).searchParams.get("all") === "true";

  try {
    const stages = await prisma.pipelineStage.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { position: "asc" },
      select: {
        id: true, code: true, nameEn: true, nameAr: true, position: true,
        probability: true, isActive: true,
        _count: { select: { opportunities: true } },
      },
    });
    return NextResponse.json({ stages });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** POST /api/sales/stages — add a stage to the end of the board. */
export async function POST(request: Request) {
  const { error } = await requireSub("sales", "stage_manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const code = typeof b.code === "string" ? b.code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9_]{2,32}$/.test(code)) {
    return NextResponse.json(
      { error: "A stage code is 2–32 characters of capital letters, digits or underscore." },
      { status: 400 },
    );
  }
  const nameEn = typeof b.nameEn === "string" ? b.nameEn.trim() : "";
  const nameAr = typeof b.nameAr === "string" ? b.nameAr.trim() : "";
  if (nameEn.length < 2 || nameAr.length < 2) {
    // Both, not one. This ERP runs in Arabic for most of its users; a stage with only an
    // English label renders as a gap on the board they actually use.
    return NextResponse.json(
      { error: "A stage needs both an English and an Arabic name." },
      { status: 400 },
    );
  }

  const probability = Number(b.probability ?? 0);
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    return NextResponse.json(
      { error: "Probability is a whole number between 0 and 100." },
      { status: 400 },
    );
  }

  try {
    const last = await prisma.pipelineStage.findFirst({
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const stage = await prisma.pipelineStage.create({
      data: {
        code,
        nameEn,
        nameAr,
        probability,
        position: (last?.position ?? 0) + 10,
      },
      select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, isActive: true },
    });

    return NextResponse.json({ stage }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/sales/stages — rename, reorder or retire stages.
 *
 * Retiring is what is offered instead of deleting, and a stage holding deals cannot even be
 * retired: the board would lose a column with cards in it, and those deals would be
 * invisible rather than moved. Move them first, deliberately.
 */
export async function PATCH(request: Request) {
  const { error } = await requireSub("sales", "stage_manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(b.stages) || b.stages.length === 0) {
    return NextResponse.json({ error: "stages must be a non-empty array." }, { status: 400 });
  }
  if (b.stages.length > 50) {
    return NextResponse.json({ error: "At most 50 stages may be updated at once." }, { status: 400 });
  }

  try {
    const updates = (b.stages as unknown[]).map((raw) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      if (typeof s.id !== "string" || !s.id) {
        throw { _appCode: 400, message: "Each stage needs an id." };
      }
      const data: Record<string, unknown> = {};
      if (typeof s.nameEn === "string" && s.nameEn.trim().length >= 2) data.nameEn = s.nameEn.trim();
      if (typeof s.nameAr === "string" && s.nameAr.trim().length >= 2) data.nameAr = s.nameAr.trim();
      if (s.position !== undefined) {
        const p = Number(s.position);
        if (!Number.isInteger(p)) throw { _appCode: 400, message: "position must be a whole number." };
        data.position = p;
      }
      if (s.probability !== undefined) {
        const p = Number(s.probability);
        if (!Number.isInteger(p) || p < 0 || p > 100) {
          throw { _appCode: 400, message: "Probability is a whole number between 0 and 100." };
        }
        data.probability = p;
      }
      if (typeof s.isActive === "boolean") data.isActive = s.isActive;
      return { id: s.id, data };
    });

    const retiring = updates.filter((u) => u.data.isActive === false).map((u) => u.id);
    if (retiring.length > 0) {
      const holding = await prisma.pipelineStage.findMany({
        where: { id: { in: retiring } },
        select: { id: true, nameEn: true, _count: { select: { opportunities: true } } },
      });
      const blocked = holding.filter((h) => h._count.opportunities > 0);
      if (blocked.length > 0) {
        throw {
          _appCode: 409,
          message:
            `${blocked[0].nameEn} still holds ${blocked[0]._count.opportunities} deals. ` +
            "Move them to another stage before retiring it.",
        };
      }
    }

    // A sequence rather than one statement: each row gets its own update, and the whole set
    // is atomic so a half-applied reorder cannot leave two columns sharing a position.
    await prisma.$transaction(
      updates
        .filter((u) => Object.keys(u.data).length > 0)
        .map((u) => prisma.pipelineStage.update({ where: { id: u.id }, data: u.data })),
    );

    const stages = await prisma.pipelineStage.findMany({
      orderBy: { position: "asc" },
      select: { id: true, code: true, nameEn: true, nameAr: true, position: true, probability: true, isActive: true },
    });

    return NextResponse.json({ stages });
  } catch (err) {
    return handleDomainError(err);
  }
}
