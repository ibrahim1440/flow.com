import { verifyMediaSignature } from "@/lib/marketing/server/connections";
import { readVersion } from "@/lib/marketing/server/assets";

/**
 * Public, signed, short-lived (≤ 2 h) access to one image version — what Meta fetches when it publishes
 * an image. No session: the HMAC signature over (version, expiry) is the authorisation. Machine-facing
 * (allow-listed in tests/ops/unit/api-errors-ar.test.ts): it answers bare statuses, never a message.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const q = new URL(req.url).searchParams;
  if (!verifyMediaSignature(versionId, q.get("exp"), q.get("sig"))) return new Response(null, { status: 403 });
  const v = await readVersion(versionId);
  if (!v || !v.mime.startsWith("image/")) return new Response(null, { status: 404 });
  return new Response(v.stream as BodyInit, { headers: { "Content-Type": v.mime, "Content-Length": String(v.size), "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" } });
}
