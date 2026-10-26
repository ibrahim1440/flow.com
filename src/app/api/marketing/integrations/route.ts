import { route } from "@/lib/marketing/server/http";
import { listConnections } from "@/lib/marketing/server/connections";
import { tokenKeyConfigured } from "@/lib/marketing/server/crypto";
import { readinessEn, sendMode, waProvider } from "@/lib/marketing/server/whatsapp-cloud";
import { aiConfigured } from "@/lib/marketing/server/ai";
import { cronSecretConfigured } from "@/lib/cron/auth";
import { publicBaseUrl } from "@/lib/marketing/server/connections";

export const GET = route(undefined, async () => {
  const mode = sendMode();
  return {
    rows: await listConnections(),
    server: {
      tokenKey: tokenKeyConfigured(), publicUrl: !!publicBaseUrl(), cronSecret: cronSecretConfigured(), ai: aiConfigured(),
      whatsappMode: mode.mode, whatsappProvider: waProvider(), whatsappNote: mode.mode === "OFF" ? mode.reasonAr : null,
      whatsappNoteEn: mode.mode === "OFF" ? readinessEn(mode.reasonAr) : null,
      storeWebhook: (process.env.STORE_WEBHOOK_SECRET?.trim().length ?? 0) >= 16,
    },
  };
});
