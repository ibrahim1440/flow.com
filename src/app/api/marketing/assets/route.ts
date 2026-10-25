import { route, qp, readJson, str, MktError } from "@/lib/marketing/server/http";
import { createCopyAsset, listAssets, uploadAsset } from "@/lib/marketing/server/assets";

export const GET = route(undefined, async (req) => {
  const q = qp(req);
  return { rows: await listAssets({ search: q.get("q"), kind: q.get("kind"), tag: q.get("tag"), campaignId: q.get("campaignId"), productId: q.get("productId"), archived: q.get("archived") === "1" }) };
});

/** multipart/form-data { file, title, kind, tags (comma separated), campaignId, productId, rights, rightsNote } — or JSON for a text asset. */
export const POST = route("content_manage", async (req, { actor }) => {
  if ((req.headers.get("content-type") ?? "").includes("application/json")) return createCopyAsset(await readJson(req), actor);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) throw new MktError("أرفق ملفاً.", "A file is required.");
  const meta = {
    title: form.get("title"), kind: form.get("kind"), campaignId: form.get("campaignId") || null, productId: form.get("productId") || null,
    rights: form.get("rights") || undefined, rightsNote: form.get("rightsNote") || null,
    tags: String(form.get("tags") ?? "").split(/[,،]/).map((t) => t.trim()).filter(Boolean),
  };
  return uploadAsset({ assetId: null, file, meta, note: str(form.get("note"), "ملاحظة", { max: 300 }) }, actor);
});
