import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { actorFrom, wsRoute } from "@/lib/workspace/server/http";
import { addAttachment, listAttachments } from "@/lib/workspace/server/attachments";

type Ctx = { params: Promise<{ id: string }> };

export const GET = wsRoute(({ actor, params }) => listAttachments(actor, params.id));

/** POST multipart/form-data with `file` (PDF / JPEG / PNG, ≤ 5 MB) — anyone who may see the open task. */
export async function POST(request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    const { id } = await params;
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const out = await addAttachment(actorFrom(user), id, file instanceof File ? file : null);
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
