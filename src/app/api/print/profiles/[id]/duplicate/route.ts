import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { PROFILE_LIMITS, profileDefinition } from "@/lib/print/profiles";
import { manageGate, requirePrintRead } from "@/lib/print/server/auth";
import { toProfileData } from "@/lib/print/server/job";
import { auditProfile } from "@/lib/print/server/profiles";

type Params = { params: Promise<{ id: string }> };

/** Duplicate any profile (presets included — that is how a preset is customised, A-3). The copy
 * belongs to the caller and is never a preset. */
export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const refused = await manageGate(user, "profiles");
  if (refused) return refused;
  const { id } = await params;
  const src = await prisma.printProfile.findUnique({ where: { id } });
  if (!src) return NextResponse.json({ error: "Profile not found.", code: "PROFILE_NOT_FOUND" }, { status: 404 });
  let name = `${src.name} (copy)`;
  try {
    const b = await req.json();
    if (typeof b?.name === "string" && b.name.trim()) name = b.name.trim();
  } catch { /* body optional */ }
  name = name.slice(0, PROFILE_LIMITS.nameMax);
  const def = { ...profileDefinition(toProfileData(src)), name };
  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.printProfile.create({ data: { ...def, isPreset: false, presetKey: null, ownerId: user.id, ownerName: user.name ?? null } });
      await auditProfile(tx, "PROFILE_CREATED", user, r, null, def);
      return r;
    });
    return NextResponse.json({ ...toProfileData(row), canEdit: true }, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
