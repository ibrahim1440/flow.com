import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { downloadDocument, removeDocument } from "@/lib/hr/services/documents";

/** Download. Audited inside the service; never cached; served as an attachment. */
export const GET = hrHandler(async ({ actor, params }) => {
  const doc = await downloadDocument(actor, params.id, params.docId);
  return new Response(new Uint8Array(doc.content), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(doc.sizeBytes),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const DELETE = hrHandler(async ({ actor, request, params }) => removeDocument(actor, params.id, params.docId, String((await readJson(request)).reason ?? "")));
