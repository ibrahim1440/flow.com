import { createHash } from "node:crypto";
import { sniffEvidenceType } from "@/lib/files/evidence-sniff";
export { sniffEvidenceType };

/**
 * Collection evidence — the private attachment adapter.
 *
 * ── Why this exists rather than a storage provider ──
 * The repository was searched before this was written: there is no attachment model, no
 * object-storage client, no signed-URL helper and no multipart handling anywhere. So this
 * is the module's own first implementation, kept deliberately small and behind one
 * interface, and the bytes live in Postgres.
 *
 * That is a considered choice, not a shortcut. The deployment target has an ephemeral
 * filesystem — a file written to disk is gone at the next cold start, which for a document
 * whose whole purpose is to be produced six months later in a dispute is worse than not
 * storing it. A receipt photo is small and low-volume. When object storage arrives, this
 * file and the `content` column are what change.
 *
 * ── Why the browser's Content-Type is ignored ──
 * It is a claim by the uploader, and an uploader who wants to store something else will
 * simply send a different one. The type is decided by the bytes.
 *
 * ── What is never logged ──
 * Not the content, not the checksum, not the filename. An error from here names the
 * problem and the limit, and nothing about the file.
 */

/** Five megabytes. A receipt photo, not a file store — and the database agrees (CHECK). */
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

export type EvidenceKind = "application/pdf" | "image/jpeg" | "image/png";

export const ALLOWED_EVIDENCE: EvidenceKind[] = ["application/pdf", "image/jpeg", "image/png"];

/** Human-facing list, for the one message that has to name what is accepted. */
export const ALLOWED_EVIDENCE_LABEL = "PDF, JPEG, PNG";

/**
 * The type the bytes actually are, or `null`.
 *
 * Signatures only, and only the three that are allowed:
 *
 *   PDF   `%PDF-`                      25 50 44 46 2D
 *   JPEG  SOI marker                   FF D8 FF
 *   PNG   the 8-byte signature         89 50 4E 47 0D 0A 1A 0A
 *
 * A file that is not one of these is refused rather than stored under a guess.
 */

export type ValidatedEvidence = {
  mimeType: EvidenceKind;
  byteSize: number;
  checksum: string;
  filename: string;
  content: Buffer;
};

export type EvidenceProblem = { code: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE"; message: string };

/**
 * Check an uploaded file and produce the row's worth of metadata, or say why not.
 *
 * Returns a problem rather than throwing, because the caller is an HTTP route that has a
 * specific status code for each case and a sentence to show the person who uploaded it.
 */
export function validateEvidence(
  bytes: Uint8Array,
  rawFilename: string,
): { ok: true; value: ValidatedEvidence } | { ok: false; problem: EvidenceProblem } {
  if (bytes.length === 0) {
    return { ok: false, problem: { code: "EMPTY", message: "That file is empty." } };
  }
  if (bytes.length > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      problem: {
        code: "TOO_LARGE",
        message: `Evidence is limited to ${MAX_EVIDENCE_BYTES / (1024 * 1024)} MB.`,
      },
    };
  }

  const mimeType = sniffEvidenceType(bytes);
  if (!mimeType) {
    return {
      ok: false,
      problem: {
        code: "UNSUPPORTED_TYPE",
        message: `Evidence must be ${ALLOWED_EVIDENCE_LABEL}. The file's own contents decide that, not its name.`,
      },
    };
  }

  const content = Buffer.from(bytes);
  return {
    ok: true,
    value: {
      mimeType,
      byteSize: content.length,
      checksum: createHash("sha256").update(content).digest("hex"),
      filename: safeFilename(rawFilename, mimeType),
      content,
    },
  };
}

const EXTENSION: Record<EvidenceKind, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * A filename safe to put in a Content-Disposition header and in a table cell.
 *
 * Directory separators, control characters and quotes are removed — a filename is
 * attacker-controlled text that ends up in a header, and `"; filename="evil` is the oldest
 * trick there is. The extension is replaced with the one matching what the bytes actually
 * are, so a PDF named `.jpg` downloads as a PDF.
 */
export function safeFilename(raw: string, mimeType: EvidenceKind): string {
  const base = (raw || "evidence")
    .replace(/[\\/]/g, "_")
    // Control characters and quotes: the filename is echoed into a Content-Disposition
    // header, and a quote or a newline in it is a header-injection primitive.
    .replace(/[\u0000-\u001f\u007f"']/g, "")
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .trim()
    .slice(0, 80);
  return `${base || "evidence"}.${EXTENSION[mimeType]}`;
}

/**
 * The headers an evidence download is served with.
 *
 * `attachment` rather than `inline`, and `nosniff`: a PDF rendered in the tab that is also
 * logged into the ERP is a document the browser will happily let script at, and a
 * mis-sniffed upload rendered as HTML is the same bug with an extra step.
 *
 * No cache. There is no public URL for this and there must not be a copy of one in a
 * shared proxy either.
 */
export function evidenceHeaders(e: { filename: string; mimeType: string; byteSize: number }): HeadersInit {
  return {
    "Content-Type": e.mimeType,
    "Content-Length": String(e.byteSize),
    "Content-Disposition": `attachment; filename="${e.filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store, private",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
}
