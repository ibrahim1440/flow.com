import { NextResponse } from "@/lib/api-response";
import { fail, readCappedBody } from "@/lib/marketing/server/http";
import { verifyHmacSha256 } from "@/lib/marketing/server/crypto";
import { receiveStoreWebhook } from "@/lib/marketing/server/store";

/**
 * The store webhook (the store link, or a middleware speaking "Hiqbah Store Webhook v1" —
 * docs/marketing/STORE-WEBHOOK.md). Authenticated by HMAC-SHA256 of the raw body with
 * STORE_WEBHOOK_SECRET in `X-Signature` (hex, optional "sha256=" prefix). An unsigned body is refused
 * before anything is stored; a signed one is stored once (idempotent on X-Event-Id, else its hash).
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.STORE_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) return NextResponse.json({ error: "استقبال بيانات المتجر غير مفعّل على الخادم.", errorEn: "Store webhook is not configured." }, { status: 503 });
  const raw = await readCappedBody(req);
  if (raw === null) return NextResponse.json({ error: "الحمولة أكبر من المسموح.", errorEn: "Payload too large." }, { status: 413 });
  const ok = verifyHmacSha256(raw, secret, req.headers.get("x-signature"));
  if (!ok) return NextResponse.json({ error: "التوقيع غير صالح.", errorEn: "Invalid signature." }, { status: 401 });
  try {
    const r = await receiveStoreWebhook(raw, ok, req.headers.get("x-event-id"));
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return fail(e);
  }
}
