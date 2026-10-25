import { route, notFound } from "@/lib/marketing/server/http";
import { readVersion } from "@/lib/marketing/server/assets";

/** The file of a version, for signed-in marketing users. `?download=1` saves instead of showing. */
export const GET = route<{ versionId: string }>(undefined, async (req, { params }) => {
  const v = await readVersion(params.versionId);
  if (!v) throw notFound();
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new Response(v.stream as BodyInit, {
    headers: {
      "Content-Type": v.mime, "Content-Length": String(v.size), "Cache-Control": "private, max-age=300",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${v.fileName}"`, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});
