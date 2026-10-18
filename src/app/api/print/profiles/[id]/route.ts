import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { validateProfile } from "@/lib/print/profiles";
import { readJson, requirePrintRead } from "@/lib/print/server/auth";
import { toProfileData } from "@/lib/print/server/job";
import { auditProfile, editableProfile, profileErrorResponse } from "@/lib/print/server/profiles";

type Params = { params: Promise<{ id: string }> };

/** Edit a profile: own (or any, administrator); presets are read-only. Audited with before/after. */
export async function PUT(req: Request, { params }: Params) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const { id } = await params;
  const e = await editableProfile(user, id);
  if ("error" in e) return e.error;
  const { body, error: bodyErr } = await readJson(req);
  if (bodyErr) return bodyErr;
  const v = validateProfile(body);
  if (!v.ok) return profileErrorResponse(v.errors);
  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.printProfile.update({ where: { id }, data: v.value });
      await auditProfile(tx, "PROFILE_UPDATED", user, r, e.data, v.value);
      return r;
    });
    return NextResponse.json({ ...toProfileData(row), canEdit: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}

/** Delete a profile: own (or any, administrator); presets cannot be deleted. Saved presets that
 * pointed at it keep their field configuration (profileId set to null by the FK). */
export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const { id } = await params;
  const e = await editableProfile(user, id);
  if ("error" in e) return e.error;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.printProfile.delete({ where: { id } });
      await auditProfile(tx, "PROFILE_DELETED", user, e.row, e.data, null);
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
