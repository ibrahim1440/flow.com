import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { sweepOrphanUploads } from "@/lib/services/customers/direct-upload";

/**
 * POST /api/admin/customer-files/orphans — the administrator's sweep of direct uploads that were
 * never finalized (services/customers/direct-upload.ts): every upload slot older than one hour loses
 * its blob and the slot, up to 500 per call (`remaining` says whether to call again). The same sweep
 * runs by itself, bounded, after the uploads' own prepare / finalize calls. Settings at edit (the
 * accounts the storage alerts go to). Only this database's own slots are touched, never a listing of
 * the store.
 */
export async function POST() {
  const { error } = await requireEdit("settings");
  if (error) return error;
  try {
    return NextResponse.json(await sweepOrphanUploads(prisma, { limit: 500 }));
  } catch (err) {
    return handleDomainError(err);
  }
}
