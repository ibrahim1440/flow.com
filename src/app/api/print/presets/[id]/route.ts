import { NextResponse } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { handlePrismaError } from "@/lib/api-error";
import { validatePreset } from "@/lib/print/presets";
import { readJson, requirePrintRead } from "@/lib/print/server/auth";
import { editablePreset } from "@/lib/print/server/profiles";
import { namedScorersColumns } from "@/lib/print/server/presets-named";

type Params = { params: Promise<{ id: string }> };

const definition = (r: { name: string; templateKey: string; language: string; fields: unknown; notesMaxLines: number | null; showLogo: boolean; profileId: string | null; namedScorersConfirmedAt: Date | null; namedScorersConfirmedById: string | null }) =>
  ({ name: r.name, templateKey: r.templateKey, language: r.language, fields: r.fields, notesMaxLines: r.notesMaxLines, showLogo: r.showLogo, profileId: r.profileId,
    namedScorers: r.namedScorersConfirmedAt !== null, privacyConfirmedBy: r.namedScorersConfirmedById, privacyConfirmedAt: r.namedScorersConfirmedAt }) as Prisma.InputJsonValue;

export async function PUT(req: Request, { params }: Params) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const { id } = await params;
  const e = await editablePreset(user, id);
  if ("error" in e) return e.error;
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
      const r = await tx.printTemplatePreset.update({ where: { id }, data: { ...v.value, ...named.data, fields: v.value.fields as Prisma.InputJsonValue } });
      await tx.printAuditLog.create({ data: { action: "PRESET_UPDATED", actorId: user.id, actorName: user.name ?? null, entityId: id, templateKey: r.templateKey, before: definition(e.row), after: definition(r) } });
      return r;
    });
    return NextResponse.json({ ...row, canEdit: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requirePrintRead();
  if (error) return error;
  const { id } = await params;
  const e = await editablePreset(user, id);
  if ("error" in e) return e.error;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.printTemplatePreset.delete({ where: { id } });
      await tx.printAuditLog.create({ data: { action: "PRESET_DELETED", actorId: user.id, actorName: user.name ?? null, entityId: id, templateKey: e.row.templateKey, before: definition(e.row) } });
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
