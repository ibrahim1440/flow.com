/**
 * A receipt chosen on a phone, made ready BEFORE «إرسال» (D20 gate L1, 10 Nov 2026).
 *
 * The server keeps PDF, JPEG and PNG up to 5 MB (services/sales/evidence.ts — it sniffs the bytes, not the name).
 * A phone camera often hands back HEIC or WebP, or a JPEG over the limit; sent as is, that failed only after the sale
 * («انسجل التحصيل، لكن ما انرفع الإيصال»). Here, in the browser:
 *   · PDF / JPEG / PNG within 5 MB → kept as chosen;
 *   · any other image, or a JPEG / PNG over 5 MB → redrawn on a canvas as a JPEG (longest side ≤ 2000 px, quality
 *     lowered until it fits); a browser that cannot decode it says so;
 *   · a PDF over 5 MB, or anything that is not an image or a PDF → refused, in words, before the sale.
 * `receiptPlan` is pure (unit-tested); `prepareReceipt` needs a browser.
 */
import { sniffEvidenceType } from "./evidence-sniff";

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
const KEEP = new Set(["application/pdf", "image/jpeg", "image/png"]);

export type ReceiptPlan = "keep" | "convert" | "pdf-too-big" | "bad-type" | "empty";

/** What to do with a chosen file, from its type and size alone. */
export function receiptPlan(type: string, size: number, name = ""): ReceiptPlan {
  // An empty file (0 bytes — a failed camera save, a cloud placeholder) is refused here, not by the server's 415.
  if (!(size > 0)) return "empty";
  const t = (type || "").toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const isPdf = t === "application/pdf" || (!t && ext === "pdf");
  if (isPdf) return size <= RECEIPT_MAX_BYTES ? "keep" : "pdf-too-big";
  // HEIC often arrives with no type at all on some phones: the extension decides.
  const isImage = t.startsWith("image/") || (!t && ["heic", "heif", "webp", "jpg", "jpeg", "png"].includes(ext));
  if (!isImage) return "bad-type";
  return KEEP.has(t) && size <= RECEIPT_MAX_BYTES ? "keep" : "convert";
}

export type ReceiptReady = { ok: true; file: File; converted: boolean } | { ok: false; ar: string; en: string };

const REFUSE = {
  empty: { ar: "الملف فاضي — صوّر الإيصال مرة ثانية أو اختر ملف ثاني.", en: "The file is empty — take the photo again or choose another file." },
  "pdf-too-big": { ar: "ملف PDF أكبر من 5 ميجا — صغّره أو صوّر الإيصال بالكاميرا.", en: "The PDF is over 5 MB — shrink it or photograph the receipt." },
  "bad-type": { ar: "نوع الملف غير مقبول — اختر صورة (JPG أو PNG) أو PDF.", en: "That file type is not accepted — choose a photo (JPG or PNG) or a PDF." },
  "bad-content": { ar: "الملف تالف أو مو ملف حقيقي من النوع المكتوب — صوّر الإيصال مرة ثانية أو اختر ملف ثاني.", en: "The file is damaged or not really the type its name says — take the photo again or choose another file." },
  "no-decode": { ar: "ما قدرنا نقرأ الصورة — صوّر الإيصال مرة ثانية أو اختر صورة JPG أو PNG.", en: "This photo could not be read — take it again or choose a JPG or PNG." },
  "still-big": { ar: "الصورة كبيرة حتى بعد التصغير — صوّر الإيصال من قريب.", en: "The photo is still too large after shrinking — photograph the receipt closer." },
} as const;

/** The file to send, or the reason (in Arabic and English) it cannot be sent — decided before the sale. */
export async function prepareReceipt(file: File): Promise<ReceiptReady> {
  const plan = receiptPlan(file.type, file.size, file.name);
  if (plan === "keep") {
    // The server keeps a file by its BYTES, not its name or type: the same signature check here, before the sale.
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (sniffEvidenceType(head)) return { ok: true, file, converted: false };
    // An «image» whose bytes are not a JPEG / PNG may still be a real photo the browser can redraw; a «PDF» cannot.
    if (!file.type.startsWith("image/")) return { ok: false, ...REFUSE["bad-content"] };
    const redrawn = await toJpeg(file);
    return redrawn.ok ? redrawn : { ok: false, ...REFUSE["bad-content"] };
  }
  if (plan !== "convert") return { ok: false, ...REFUSE[plan] };
  return toJpeg(file);
}

/** Redraw a photo the browser can decode as a JPEG under 5 MB. */
async function toJpeg(file: File): Promise<ReceiptReady> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return { ok: false, ...REFUSE["no-decode"] }; }
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, ...REFUSE["no-decode"] };
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // a transparent PNG / WebP gets a white page, not black
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  for (const q of [0.85, 0.72, 0.6, 0.45]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= RECEIPT_MAX_BYTES) {
      const base = (file.name || "receipt").replace(/\.[^.]+$/, "") || "receipt";
      return { ok: true, file: new File([blob], `${base}.jpg`, { type: "image/jpeg" }), converted: true };
    }
  }
  return { ok: false, ...REFUSE["still-big"] };
}
