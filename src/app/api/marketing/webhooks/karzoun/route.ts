import { NextResponse } from "@/lib/api-response";
import { fail, readCappedBody } from "@/lib/marketing/server/http";
import { verifyKarzounSignature } from "@/lib/marketing/server/karzoun";
import { applyKarzounWebhook } from "@/lib/marketing/server/messaging";

/**
 * Karzoun outbound webhook (Developer › Webhooks, event core:customer.update). Authenticated by
 * `X-Karzoun-Signature-256` (HMAC-SHA256 of the raw body with KARZOUN_WEBHOOK_SECRET); during a
 * secret rotation the `-Previous` header is accepted too. Nothing unsigned is stored or applied.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.KARZOUN_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) return NextResponse.json({ error: "استقبال أحداث كرزون غير مفعّل على الخادم.", errorEn: "Karzoun webhook is not configured." }, { status: 503 });
  const raw = await readCappedBody(req);
  if (raw === null) return NextResponse.json({ error: "الحمولة أكبر من المسموح.", errorEn: "Payload too large." }, { status: 413 });
  if (!verifyKarzounSignature(raw, req.headers.get("x-karzoun-signature-256"), req.headers.get("x-karzoun-signature-256-previous"))) {
    return NextResponse.json({ error: "التوقيع غير صالح.", errorEn: "Invalid signature." }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await applyKarzounWebhook(raw)) });
  } catch (e) {
    return fail(e);
  }
}
