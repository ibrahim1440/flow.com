import { financeHandler } from "@/lib/finance/server/http";
import { getAttachment } from "@/lib/finance/server/transactions";

export const GET = financeHandler(undefined, async ({ scope, params }) => {
    const a = await getAttachment(scope, params.id);
    return new Response(Buffer.from(a.content), {
      headers: {
        "Content-Type": a.contentType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(a.fileName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
