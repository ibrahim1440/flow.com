import { NextResponse } from "@/lib/api-response";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { profileDefinition, type ProfileError, type ProfileInput } from "../profiles";
import { manageGate, ownerOverrideGate } from "./auth";
import { toProfileData } from "./job";

type User = Awaited<ReturnType<typeof requireAuth>>["user"];
type Tx = Prisma.TransactionClient;

export function profileErrorResponse(errors: ProfileError[]) {
  return NextResponse.json({ error: "The profile is not valid.", code: errors[0]?.code ?? "PROFILE_INVALID", errors }, { status: 400 });
}

export async function auditProfile(tx: Tx, action: "PROFILE_CREATED" | "PROFILE_UPDATED" | "PROFILE_DELETED", user: User, row: { id: string; name: string }, before: ProfileInput | null, after: ProfileInput | null) {
  await tx.printAuditLog.create({
    data: {
      action, actorId: user.id, actorName: user.name ?? null, entityId: row.id, profileId: row.id, profileName: row.name,
      before: (before ? profileDefinition(before) : undefined) as Prisma.InputJsonValue | undefined,
      after: (after ? profileDefinition(after) : undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/**
 * Loads a profile the caller may change: manage permission, not a preset (409), own unless
 * administrator (403). Returns the response to send on refusal.
 */
export async function editableProfile(user: User, id: string) {
  const refused = await manageGate(user, "profiles");
  if (refused) return { error: refused } as const;
  const row = await prisma.printProfile.findUnique({ where: { id } });
  if (!row) return { error: NextResponse.json({ error: "Profile not found.", code: "PROFILE_NOT_FOUND" }, { status: 404 }) } as const;
  if (row.isPreset) return { error: NextResponse.json({ error: "Presets are read-only starting points; duplicate one to change it.", code: "PROFILE_PRESET_READONLY" }, { status: 409 }) } as const;
  const override = await ownerOverrideGate(user, row.ownerId, "Only the profile's owner or an administrator may change it.");
  if (override) return { error: override } as const;
  return { row, data: toProfileData(row) } as const;
}

export async function editablePreset(user: User, id: string) {
  const refused = await manageGate(user, "presets");
  if (refused) return { error: refused } as const;
  const row = await prisma.printTemplatePreset.findUnique({ where: { id } });
  if (!row) return { error: NextResponse.json({ error: "Preset not found.", code: "PRESET_NOT_FOUND" }, { status: 404 }) } as const;
  const override = await ownerOverrideGate(user, row.ownerId, "Only the preset's owner or an administrator may change it.");
  if (override) return { error: override } as const;
  return { row } as const;
}
