import { hrHandler } from "@/lib/hr/http";
import { runExpiryNow } from "@/lib/hr/services/document-expiry";

// «تشغيل الآن» (hr › policy_manage): the daily check, now. Idempotent — the same day adds nothing twice.
export const maxDuration = 60;
export const POST = hrHandler(async ({ actor }) => runExpiryNow(actor));
