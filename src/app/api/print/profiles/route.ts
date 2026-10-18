import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { validateProfile } from "@/lib/print/profiles";
import { canManageProfiles, manageGate, readJson, requirePrintRead } from "@/lib/print/server/auth";
import { toProfileData } from "@/lib/print/server/job";
import { auditProfile, profileErrorResponse } from "@/lib/print/server/profiles";

/** Every profile (presets first). Anyone who prints may select any profile; `canEdit` per row. */
export async function GET() {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const rows = await prisma.printProfile.findMany({ orderBy: [{ isPreset: "desc" }, { name: "asc" }] });
  const manage = canManageProfiles(user);
  return NextResponse.json({
    canManage: manage,
    profiles: rows.map((r) => ({ ...toProfileData(r), canEdit: manage && !r.isPreset && (user.role === "admin" || r.ownerId === user.id) })),
  });
}

/** Create a profile (labels.profile_manage or administrator). Owner = the caller. */
export async function POST(req: Request) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const refused = await manageGate(user, "profiles");
  if (refused) return refused;
  const { body, error: bodyErr } = await readJson(req);
  if (bodyErr) return bodyErr;
  const v = validateProfile(body);
  if (!v.ok) return profileErrorResponse(v.errors);
  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.printProfile.create({ data: { ...v.value, isPreset: false, presetKey: null, ownerId: user.id, ownerName: user.name ?? null } });
      await auditProfile(tx, "PROFILE_CREATED", user, r, null, v.value);
      return r;
    });
    return NextResponse.json({ ...toProfileData(row), canEdit: true }, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
