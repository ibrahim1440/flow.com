// What an uploaded marketing file really is — from its bytes, never from its name or the browser's
// claim. Pure. SVG is refused on purpose: it is a document that can carry script.

export type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "video/mp4" | "video/quicktime" | "application/pdf" | "image/vnd.adobe.photoshop";

export const MEDIA_EXT: Record<MediaType, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4",
  "video/quicktime": ".mov", "application/pdf": ".pdf", "image/vnd.adobe.photoshop": ".psd",
};

/** Through the app's own route (Vercel's request body limit is 4.5 MB). Larger files: Phase 2 direct upload. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;

export function sniffMedia(b: Uint8Array): MediaType | null {
  const at = (i: number) => b[i];
  const ascii = (i: number, s: string) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => at(i) === x)) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (ascii(0, "8BPS")) return "image/vnd.adobe.photoshop";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    if (brand === "qt  ") return "video/quicktime";
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(brand)) return "video/mp4";
  }
  return null;
}

export function kindOfMime(m: MediaType): "image" | "video" | "document" {
  return m.startsWith("image/") && m !== "image/vnd.adobe.photoshop" ? "image" : m.startsWith("video/") ? "video" : "document";
}

/** Pixel size of PNG / JPEG / GIF / WEBP(VP8X, VP8, VP8L) when readable; null otherwise. */
export function imageSize(b: Uint8Array, m: MediaType): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  try {
    if (m === "image/png" && b.length >= 24) return { width: u32be(16), height: u32be(20) };
    if (m === "image/gif" && b.length >= 10) return { width: u16le(6), height: u16le(8) };
    if (m === "image/webp" && b.length >= 30) {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (m === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = u16be(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: u16be(i + 7), height: u16be(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** ASCII-only file name for storage paths (Blob pathnames are URLs). */
export function safeFileName(name: string, mime: MediaType): string {
  const stem = name.replace(/\.[A-Za-z0-9]+$/, "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80);
  return `${stem || "asset"}${MEDIA_EXT[mime]}`;
}
