import { createHash } from "node:crypto";

/**
 * A short digest of an account's credentials (username and the stored PIN and password hashes —
 * never the secrets themselves). Carried in the session token; a token whose digest no longer
 * matches the row is refused, so changing any credential revokes every earlier session.
 */
export function credentialVersion(e: { id: string; username: string | null; pin: string | null; password: string | null }): string {
  return createHash("sha256").update(`${e.id}|${e.username ?? ""}|${e.pin ?? ""}|${e.password ?? ""}`).digest("hex").slice(0, 20);
}
