/**
 * Load a Sales-Preview credential and prove, before handing it to anything, that it points
 * at the isolated preview database.
 *
 * The credentials live outside the repository so none is ever written into it. The assertion
 * is deliberately positive — an allowlist of the one host and the one database name — with
 * the known production endpoints named separately so a refusal says which rule it broke.
 * A denylist alone can only ever name the systems somebody remembered.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".beanflow", "sales-preview");

/** The only database these scripts may reach. */
export const ALLOWED_DB = "sales_preview";
export const ALLOWED_HOST_PREFIX = "ep-wandering-leaf-";
/** Named so a refusal is legible, not because the allowlist above needs help. */
export const FORBIDDEN_HOST_PREFIXES = ["ep-dawn-dust", "ep-jolly-feather", "ep-icy-field"];

/**
 * @param {"app" | "migrate"} which  `app` is the restricted runtime role, `migrate` the one
 *                                   that holds DDL. Ask for the weakest that will do.
 */
export function loadPreviewEnv(which) {
  const file = path.join(DIR, which === "migrate" ? ".env.preview-migrate" : ".env.preview-app");
  if (!fs.existsSync(file)) {
    throw new Error(`No preview credential at ${file}.`);
  }

  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }

  for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
    const raw = env[key];
    if (!raw) throw new Error(`${key} is missing from ${path.basename(file)}.`);
    const url = new URL(raw);
    const db = url.pathname.replace(/^\//, "");

    if (FORBIDDEN_HOST_PREFIXES.some((h) => url.hostname.startsWith(h))) {
      throw new Error(`REFUSED: ${key} points at ${url.hostname}, a protected endpoint.`);
    }
    if (!url.hostname.startsWith(ALLOWED_HOST_PREFIX) || db !== ALLOWED_DB) {
      throw new Error(
        `REFUSED: ${key} must be ${ALLOWED_HOST_PREFIX}* / ${ALLOWED_DB}; it is ${url.hostname} / ${db}.`,
      );
    }
  }

  // Host and database only. Never the credential, and never the whole URL.
  const shown = new URL(env.DIRECT_URL);
  return {
    env,
    target: `${shown.hostname} / ${shown.pathname.replace(/^\//, "")}`,
    role: shown.username,
  };
}
