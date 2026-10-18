import { hrHandler } from "@/lib/hr/http";
import { uploadDocument } from "@/lib/hr/services/documents";

export const POST = hrHandler(async ({ actor, request, params }) => uploadDocument(actor, params.id, await request.formData()), { status: 201 });
