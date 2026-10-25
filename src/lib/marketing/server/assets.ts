import "server-only";
import { randomBytes } from "node:crypto";
import { prisma, TX_OPTS } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { chooseStorage } from "@/lib/services/customers/file-store";
import { MktError, notFound, str, oneOf, strList, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { sha256 } from "./crypto";
import { MAX_ASSET_BYTES, imageSize, safeFileName, sniffMedia } from "../media";

export const ASSET_KINDS = ["IMAGE", "VIDEO", "DESIGN_SOURCE", "DOCUMENT", "COPY"] as const;
export const RIGHTS = ["OWNED", "LICENSED", "UGC_PERMISSION", "STOCK", "UNKNOWN"] as const;

/**
 * The content library. Bytes go to the same private store the customer files use (Vercel Blob when
 * configured, else the row), under marketing/<assetId>/<versionId>-<name>. A new upload is a NEW
 * version; version 1 is the original and is never replaced or deleted by the application.
 */

const cuidish = () => `mv${randomBytes(12).toString("hex")}`;

export async function listAssets(q: { search?: string | null; kind?: string | null; tag?: string | null; campaignId?: string | null; productId?: string | null; archived?: boolean }) {
  const rows = await prisma.mktAsset.findMany({
    where: {
      archived: q.archived ?? false,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.search ? { OR: [{ title: { contains: q.search, mode: "insensitive" } }, { text: { contains: q.search, mode: "insensitive" } }, { tags: { has: q.search } }] } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 300,
    include: {
      versions: { orderBy: { version: "desc" }, select: { id: true, version: true, isOriginal: true, fileName: true, mimeType: true, sizeBytes: true, width: true, height: true, createdAt: true, note: true } },
      campaign: { select: { id: true, name: true } },
      product: { select: { id: true, productNameAr: true, productNameEn: true } },
      _count: { select: { postLinks: true } },
    },
  });
  return rows.map((a) => ({
    id: a.id, title: a.title, kind: a.kind, tags: a.tags, rights: a.rights, rightsNote: a.rightsNote, text: a.text, brief: a.brief,
    aiGenerated: a.aiGenerated, archived: a.archived, createdAt: a.createdAt, updatedAt: a.updatedAt,
    campaign: a.campaign, product: a.product ? { id: a.product.id, name: a.product.productNameAr ?? a.product.productNameEn } : null,
    versions: a.versions, usedInPosts: a._count.postLinks,
  }));
}

function readMeta(body: Record<string, unknown>, partial: boolean) {
  const data: Prisma.MktAssetUncheckedUpdateInput = {};
  const has = (k: string) => !partial || k in body;
  if (has("title")) data.title = str(body.title, "العنوان", { max: 200, required: true })!;
  if (has("kind")) data.kind = oneOf(body.kind, ASSET_KINDS, "النوع");
  if (has("tags")) data.tags = strList(body.tags, "الوسوم", 30);
  if (has("campaignId")) data.campaignId = str(body.campaignId, "الحملة");
  if (has("productId")) data.productId = str(body.productId, "المنتج");
  if (has("rights")) data.rights = oneOf(body.rights, RIGHTS, "حقوق الاستخدام", "UNKNOWN");
  if (has("rightsNote")) data.rightsNote = str(body.rightsNote, "مصدر الحقوق", { max: 1000 });
  if (has("text")) data.text = str(body.text, "النص", { max: 20000 });
  if (has("brief")) data.brief = (body.brief && typeof body.brief === "object" ? body.brief : null) as Prisma.InputJsonValue;
  return data;
}

/** A text asset (caption, headline set, CTA list) — no file. */
export async function createCopyAsset(body: Record<string, unknown>, actor: Actor, opts: { aiGenerated?: boolean } = {}) {
  if (!can(actor, "content_manage")) throw denied();
  const data = readMeta({ ...body, kind: "COPY" }, false) as Prisma.MktAssetUncheckedCreateInput;
  if (!data.text) throw new MktError("النص مطلوب لمادة نصية.", "Text is required.");
  return prisma.$transaction(async (tx) => {
    const a = await tx.mktAsset.create({ data: { ...data, aiGenerated: opts.aiGenerated === true, createdById: actor.id } });
    await audit(tx, userActor(actor), "asset.created", "MktAsset", a.id, { after: { title: a.title, kind: a.kind, aiGenerated: a.aiGenerated } });
    return a;
  }, TX_OPTS);
}

/**
 * Upload: a new asset (no assetId) or a new version of an existing one. The type is proven from the
 * bytes; the size is capped; the bytes are hashed; the original version is flagged.
 */
export async function uploadAsset(args: { assetId: string | null; file: File; meta: Record<string, unknown>; note: string | null }, actor: Actor) {
  if (!can(actor, "content_manage")) throw denied();
  if (args.file.size <= 0) throw new MktError("الملف فارغ.", "Empty file.");
  if (args.file.size > MAX_ASSET_BYTES) throw new MktError(`حجم الملف يتجاوز ${MAX_ASSET_BYTES / 1024 / 1024} ميغابايت (رفع الملفات الأكبر في المرحلة الثانية).`, "File too large.", 413, "MKT_TOO_LARGE");
  const bytes = Buffer.from(await args.file.arrayBuffer());
  const mime = sniffMedia(bytes);
  if (!mime) throw new MktError("نوع الملف غير مدعوم (JPG, PNG, WEBP, GIF, MP4, MOV, PDF, PSD).", "Unsupported file type.", 415, "MKT_TYPE");
  const dims = imageSize(bytes, mime);
  const hash = sha256(bytes);
  const versionId = cuidish();
  const storage = chooseStorage();

  let assetId = args.assetId;
  if (!assetId) {
    const meta = readMeta(args.meta, false) as Prisma.MktAssetUncheckedCreateInput;
    if (meta.kind === "COPY") throw new MktError("المادة النصية لا تحمل ملفاً.", "Copy assets carry no file.");
    const a = await prisma.mktAsset.create({ data: { ...meta, createdById: actor.id } });
    assetId = a.id;
  } else {
    const a = await prisma.mktAsset.findUnique({ where: { id: assetId } });
    if (!a) throw notFound();
    if (a.archived) throw new MktError("المادة مؤرشفة.", "Asset is archived.", 409);
    if (a.kind === "COPY") throw new MktError("المادة النصية لا تحمل ملفاً.", "Copy assets carry no file.");
  }
  const fileName = safeFileName(args.file.name || "asset", mime);
  const pathname = `marketing/${assetId}/${versionId}-${fileName}`;
  if (storage.kind === "blob") await storage.store.put(pathname, bytes, mime);

  try {
    return await prisma.$transaction(async (tx) => {
      const last = await tx.mktAssetVersion.findFirst({ where: { assetId: assetId! }, orderBy: { version: "desc" }, select: { version: true, sha256: true } });
      if (last?.sha256 === hash) throw new MktError("هذا الملف مطابق للإصدار الأخير.", "Identical to the latest version.", 409, "MKT_SAME_FILE");
      const v = await tx.mktAssetVersion.create({
        data: {
          id: versionId, assetId: assetId!, version: (last?.version ?? 0) + 1, isOriginal: !last, fileName, mimeType: mime, sizeBytes: bytes.length, sha256: hash,
          width: dims?.width ?? null, height: dims?.height ?? null,
          content: storage.kind === "db" ? bytes : null, blobPathname: storage.kind === "blob" ? pathname : null,
          note: args.note, createdById: actor.id,
        },
      });
      await tx.mktAsset.update({ where: { id: assetId! }, data: { updatedAt: new Date() } });
      await audit(tx, userActor(actor), last ? "asset.version_added" : "asset.created", "MktAsset", assetId, { after: { version: v.version, fileName, mime, size: bytes.length, sha256: hash } });
      return { assetId: assetId!, versionId: v.id, version: v.version };
    }, TX_OPTS);
  } catch (e) {
    if (storage.kind === "blob") await storage.store.del([pathname]).catch(() => undefined);
    if (!args.assetId) await prisma.mktAsset.delete({ where: { id: assetId! } }).catch(() => undefined);
    throw e;
  }
}

export async function updateAssetMeta(id: string, body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "content_manage")) throw denied();
  const data = readMeta(body, true);
  if ("archived" in body) data.archived = body.archived === true;
  return prisma.$transaction(async (tx) => {
    const before = await tx.mktAsset.findUnique({ where: { id } });
    if (!before) throw notFound();
    if (data.kind && data.kind !== before.kind && (before.kind === "COPY") !== (data.kind === "COPY")) throw new MktError("لا يمكن تحويل مادة نصية إلى ملف أو العكس.", "Cannot switch between copy and file.");
    const a = await tx.mktAsset.update({ where: { id }, data });
    await audit(tx, userActor(actor), data.archived === true ? "asset.archived" : "asset.updated", "MktAsset", id, { before: { title: before.title, tags: before.tags, archived: before.archived }, after: { title: a.title, tags: a.tags, archived: a.archived } });
    return a;
  }, TX_OPTS);
}

/** The bytes of a version, streamed. Never exposes the Blob pathname. */
export async function readVersion(versionId: string): Promise<{ stream: ReadableStream<Uint8Array> | Buffer; mime: string; size: number; fileName: string } | null> {
  const v = await prisma.mktAssetVersion.findUnique({ where: { id: versionId } });
  if (!v) return null;
  if (v.content) return { stream: Buffer.from(v.content), mime: v.mimeType, size: v.sizeBytes, fileName: v.fileName };
  if (!v.blobPathname) return null;
  const storage = chooseStorage();
  if (storage.kind !== "blob") return null;
  const got = await storage.store.get(v.blobPathname);
  if (!got) return null;
  return { stream: got.stream, mime: v.mimeType, size: v.sizeBytes, fileName: v.fileName };
}
