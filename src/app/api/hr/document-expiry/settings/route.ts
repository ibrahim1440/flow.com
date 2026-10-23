import { hrHandler } from "@/lib/hr/http";
import { readJson } from "@/lib/hr/core";
import { expirySettings, saveExpirySettings } from "@/lib/hr/services/document-expiry";

// HR settings «تنبيهات انتهاء الوثائق» (hr › policy_manage): the thresholds and the last run.
export const GET = hrHandler(async ({ actor }) => expirySettings(actor));
export const PUT = hrHandler(async ({ actor, request }) => saveExpirySettings(actor, await readJson(request)));
