import { route, readJson, str, MktError } from "@/lib/marketing/server/http";
import { updateAssetMeta, uploadAsset } from "@/lib/marketing/server/assets";

type P = { id: string };

export const PATCH = route<P>("content_manage", async (req, { actor, params }) => updateAssetMeta(params.id, await readJson(req), actor));

/** A new version of the asset (multipart { file, note }). The original stays. */
export const POST = route<P>("content_manage", async (req, { actor, params }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) throw new MktError("أرفق ملفاً.", "A file is required.");
  return uploadAsset({ assetId: params.id, file, meta: {}, note: str(form.get("note"), "ملاحظة", { max: 300 }) }, actor);
});
