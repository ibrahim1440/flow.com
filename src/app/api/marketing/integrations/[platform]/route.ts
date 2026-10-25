import { route, readJson } from "@/lib/marketing/server/http";
import { checkConnection, disconnect, saveConnection } from "@/lib/marketing/server/connections";

type P = { platform: string };

export const PUT = route<P>("integrations_manage", async (req, { actor, params }) => saveConnection(params.platform, await readJson(req), actor));

/** A live connection check against the platform. */
export const POST = route<P>("integrations_manage", async (_req, { actor, params }) => checkConnection(params.platform, actor));

export const DELETE = route<P>("integrations_manage", async (_req, { actor, params }) => {
  await disconnect(params.platform, actor);
  return { ok: true };
});
