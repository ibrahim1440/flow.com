// Which database these suites are allowed to write to.
//
// ── Why a database name is not an identity ───────────────────────────────────
// The first version of this guard allowlisted the database NAME and nothing else. That
// was safe only by accident. Neon names the first database in every project `neondb`, so
// Production is `neondb` and a freshly created test project is ALSO `neondb` — the same
// string, two different servers, one of them carrying the company's real orders. Anyone
// wiring up a new test project would have found the runner refusing it and done the
// obvious thing: add `neondb` to the allowlist. That single edit would have made the
// Production connection string pass the guard, and these suites create, mutate and
// delete data.
//
// A name is therefore never sufficient. The target is identified by WHERE it is as well
// as WHAT it is called, and both halves must match.
//
// ── Order matters ────────────────────────────────────────────────────────────
// Protected endpoints are rejected BEFORE any allowlist is consulted, and that rejection
// cannot be configured away — no environment variable relaxes it. An allowlist is a
// statement about what is permitted; the protected list is a statement about what is
// never permitted, and the second has to win. Everything unrecognised is refused rather
// than allowed, so a host this file has never heard of cannot be written to by accident.

/**
 * Endpoints that must never be written to, whatever database is named and whatever the
 * environment says. Deliberately not overridable.
 */
export const PROTECTED_ENDPOINTS = Object.freeze(["ep-dawn-dust-aqn1u1uf"]);

/** The isolated regression project. Override with ERP_TEST_DB_ENDPOINT if it moves. */
export const DEFAULT_APPROVED_ENDPOINTS = Object.freeze(["ep-small-hat-aw2kcuac"]);

/** The database inside it these suites are meant to use. */
export const DEFAULT_APPROVED_DATABASES = Object.freeze(["erp_mvp_test"]);

/**
 * The Neon endpoint id for a host.
 *
 * Neon serves the same compute on two hostnames — `ep-x-y.region.aws.neon.tech` and a
 * pooled `ep-x-y-pooler.region.aws.neon.tech`. They are one endpoint, so the suffix is
 * stripped: otherwise the pooled form of a protected host would slip past a check written
 * against the direct one.
 */
export function endpointOf(hostname) {
  if (!hostname) return null;
  const first = String(hostname).trim().toLowerCase().split(".")[0];
  if (!first) return null;
  return first.replace(/-pooler$/, "");
}

/** Parse a connection string into the two things the decision needs. Never throws. */
export function parseTarget(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
  if (!u.hostname) return null;
  const endpoint = endpointOf(u.hostname);
  if (!endpoint) return null;
  const database = u.pathname.replace(/^\//, "").split("?")[0];
  if (!database) return null;
  return { host: u.hostname.toLowerCase(), endpoint, database };
}

const list = (value, fallback) =>
  value === undefined || value === null || String(value).trim() === ""
    ? [...fallback]
    : String(value).split(",").map((s) => s.trim()).filter(Boolean);

/**
 * May these suites write to this target?
 *
 * Returns a verdict rather than throwing, so the self-tests can exercise every branch
 * without a process exit. `reason` never contains the connection string.
 */
export function classifyTarget(url, opts = {}) {
  const approvedEndpoints = list(opts.endpoints, DEFAULT_APPROVED_ENDPOINTS);
  const approvedDatabases = list(opts.databases, DEFAULT_APPROVED_DATABASES);

  if (typeof url !== "string" || url.trim() === "") {
    return { allowed: false, endpoint: null, database: null, reason: "no connection string was supplied." };
  }

  const t = parseTarget(url);
  if (!t) {
    return {
      allowed: false, endpoint: null, database: null,
      reason: "the connection string is not a valid postgres URL naming a host and a database.",
    };
  }

  // Protected first, and unconditionally — before any allowlist is read.
  // Checked against the parsed endpoint AND the raw host, so a protected compute cannot be
  // reached through a hostname that merely contains it.
  for (const p of PROTECTED_ENDPOINTS) {
    if (t.endpoint === p || t.host.includes(p)) {
      return {
        allowed: false, endpoint: t.endpoint, database: t.database,
        reason: `endpoint "${t.endpoint}" is a PROTECTED PRODUCTION endpoint. ` +
                "These suites write, and will never run against it — whatever database is named.",
      };
    }
  }

  if (!approvedEndpoints.includes(t.endpoint)) {
    return {
      allowed: false, endpoint: t.endpoint, database: t.database,
      reason: `endpoint "${t.endpoint}" is not an approved regression endpoint ` +
              `(${approvedEndpoints.join(", ")}).`,
    };
  }

  if (!approvedDatabases.includes(t.database)) {
    return {
      allowed: false, endpoint: t.endpoint, database: t.database,
      reason: `database "${t.database}" is not the approved regression database ` +
              `(${approvedDatabases.join(", ")}) on endpoint "${t.endpoint}".`,
    };
  }

  return { allowed: true, endpoint: t.endpoint, database: t.database, reason: "approved regression target." };
}

/** endpoint/database, safe to log — no user, no password, no query string. */
export function describeTarget(url) {
  const t = parseTarget(url);
  return t ? `${t.endpoint}/${t.database}` : "(unparseable)";
}
