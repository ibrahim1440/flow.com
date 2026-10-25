import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { actorFrom, wsRoute } from "@/lib/workspace/server/http";
import { openAttachment, removeAttachment } from "@/lib/workspace/server/attachments";

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

/** GET — the file, as a download (no inline rendering, no cache). */
export async function GET(_request: Request, { params }: Ctx) {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    const { id, attachmentId } = await params;
    return await openAttachment(actorFrom(user), id, attachmentId);
  } catch (err) {
    return handleDomainError(err);
  }
}

export const DELETE = wsRoute(({ actor, params }) => removeAttachment(actor, params.id, params.attachmentId));
