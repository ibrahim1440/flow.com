import { route, readJson } from "@/lib/marketing/server/http";
import { saveBrandKit } from "@/lib/marketing/server/settings-service";

// The brand kit is content work: the content team edits it, as the screen and saveBrandKit allow.
export const PUT = route(["automation_manage", "content_manage"], async (req, { actor }) => saveBrandKit(await readJson(req), actor));
