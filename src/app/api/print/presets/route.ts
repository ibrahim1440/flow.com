import { NextResponse } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { validatePreset } from "@/lib/print/presets";
import { canManagePresets, canNameScorers, manageGate, readJson, requirePrintRead } from "@/lib/print/server/auth";
import { namedScorersColumns } from "@/lib/print/server/presets-named";

/** Saved label presets (shared; anyone who prints may use any). `canEdit` per row. */
export async function GET() {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const rows = await prisma.printTemplatePreset.findMany({ orderBy: [{ templateKey: "asc" }, { name: "asc" }] });
  const manage = canManagePresets(user);
  // Data minimization (QA P3-7): who confirmed a named-scorer preset is shown to template managers only.
  return NextResponse.json({
    canManage: manage, canNameScorers: canNameScorers(user),
    presets: rows.map((r) => {
      const row = { ...r, canEdit: manage && (user.role === "admin" || r.ownerId === user.id) };
      return manage ? row : { ...row, namedScorersConfirmedById: undefined };
    }),
  });
}

export async function POST(req: Request) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const refused = await manageGate(user, "presets");
  if (refused) return refused;
  const { body, error: bodyErr } = await readJson(req);
  if (bodyErr) return bodyErr;
  const v = validatePreset(body);
  if (!v.ok) return NextResponse.json({ error: "The preset is not valid.", code: v.errors[0].code, errors: v.errors }, { status: 400 });
  const named = namedScorersColumns(user, v.value, body!);
  if ("error" in named) return named.error;
  if (v.value.profileId && !(await prisma.printProfile.findUnique({ where: { id: v.value.profileId }, select: { id: true } }))) {
    return NextResponse.json({ error: "Profile not found.", code: "PROFILE_NOT_FOUND" }, { status: 400 });
  }
  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.printTemplatePreset.create({ data: { ...v.value, ...named.data, fields: v.value.fields as Prisma.InputJsonValue, ownerId: user.id, ownerName: user.name ?? null } });
      await tx.printAuditLog.create({ data: { action: "PRESET_CREATED", actorId: user.id, actorName: user.name ?? null, entityId: r.id, templateKey: r.templateKey, after: { ...v.value, namedScorers: named.data.namedScorersConfirmedAt !== null, privacyConfirmedBy: named.data.namedScorersConfirmedById } as Prisma.InputJsonValue } });
      return r;
    });
    return NextResponse.json({ ...row, canEdit: true }, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
