/**
 * Refuse, BEFORE execution, any test statement that could mutate an identity the tests do not
 * own.
 *
 * ── Why this exists, and what it replaces ──────────────────────────────────
 * The first attempt at protecting the reviewer's accounts counted `RVW_` rows before and after
 * fixture teardown and failed the run if any had gone. That detects one kind of damage after
 * it has happened. It does not detect a changed PIN, a deactivation, or a rewritten
 * permissions blob, and it does not prevent anything — by the time it fires, the reviewer is
 * already locked out and the run is already red for a reason that looks unrelated.
 *
 * This runs first instead. Every query the suites issue goes through one client in each layer,
 * and this is called on the way past.
 *
 * ── What it actually guarantees ────────────────────────────────────────────
 * For INSERT / UPDATE / DELETE against an identity table, it refuses when:
 *
 *   1. the statement text or any bound parameter names a reserved identity;
 *   2. the statement is unscoped — a DELETE or UPDATE with no WHERE at all;
 *   3. any LIKE pattern in the statement would match a reserved identity. This is the case
 *      worth having: a teardown pattern widened from `UAT\_emp\_%` to `%\_emp\_%` matches
 *      `RVW_emp_rep`, and nothing else in the suite would notice.
 *
 * ── What it does NOT guarantee ─────────────────────────────────────────────
 * It reads SQL text; it is not a database permission. A mutation whose row set comes from a
 * subquery it cannot evaluate (`WHERE id IN (SELECT ...)`) is checked only for the patterns
 * above, so a subquery that selects a reserved row by some other route would pass. Code that
 * opens its own connection bypasses it entirely — which is why both layers are funnelled
 * through a single client, and why that property is worth preserving.
 *
 * The database-level equivalents are stronger and are deliberately not done here: a trigger on
 * `Employee` would be undeclared schema drift in the database used to validate migrations, and
 * a separate low-privilege role for the suites is a larger change than this task's scope.
 */

/** Identities the test suites must never touch. Owned by a person, not by a fixture. */
export const RESERVED_PREFIXES = ["RVW_"];

/** Concrete ids used to evaluate LIKE patterns against. Sample, not an inventory. */
export const RESERVED_SAMPLES = [
  "RVW_emp_rep",
  "RVW_emp_manager",
  "RVW_emp_finance",
  "RVW_plan_standard",
  "RVW_ver_standard",
  "RVW_asg_rep",
];

/** Tables where a row IS an identity or an identity's entitlement. */
const IDENTITY_TABLES = [
  "Employee",
  "CommissionAssignment",
  "CommissionPlan",
  "CommissionPlanVersion",
];

const MUTATING = /^\s*(insert\s+into|update|delete\s+from|truncate)\b/i;

/** SQL LIKE → RegExp. `%` is any run, `_` is one character, `\` escapes both. */
function likeToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[++i];
      if (next === undefined) { out += "\\\\"; break; }
      out += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

/** Every single-quoted literal in the statement, with '' un-escaped. */
function stringLiterals(sql) {
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** The literals that appear as the right-hand side of a LIKE. */
function likePatterns(sql) {
  return [...sql.matchAll(/\blike\s+'((?:[^']|'')*)'/gi)].map((m) => m[1].replace(/''/g, "'"));
}

const namesIdentityTable = (sql) =>
  IDENTITY_TABLES.some((t) => new RegExp(`"${t}"`).test(sql));

const reserved = (value) =>
  typeof value === "string" && RESERVED_PREFIXES.some((p) => value.startsWith(p));

/**
 * Throws if this statement must not run. Returns silently otherwise.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {string} [origin] where the statement came from, for the error message
 */
export function assertTestOwnedMutation(sql, params = [], origin = "the test suite") {
  if (typeof sql !== "string" || !MUTATING.test(sql)) return;
  if (!namesIdentityTable(sql)) return;

  const refuse = (why) => {
    throw new Error(
      `Refused before execution: ${origin} tried to mutate an identity it does not own.\n` +
      `  ${why}\n` +
      `  Reserved prefixes: ${RESERVED_PREFIXES.join(", ")} — these belong to a person reviewing\n` +
      `  the Preview, not to this suite. Scope the statement to the suite's own prefix.`,
    );
  };

  // 1. Named outright, in the text or in a bound parameter.
  for (const lit of stringLiterals(sql)) {
    if (reserved(lit)) refuse(`the statement contains the literal "${lit}".`);
  }
  for (const p of params) {
    if (reserved(p)) refuse(`a bound parameter is "${p}".`);
    if (Array.isArray(p)) {
      for (const v of p) if (reserved(v)) refuse(`a bound array parameter contains "${v}".`);
    }
  }

  // 2. Unscoped. A DELETE or TRUNCATE with no WHERE takes everything with it.
  const isDelete = /^\s*(delete\s+from|truncate)\b/i.test(sql);
  const isUpdate = /^\s*update\b/i.test(sql);
  if ((isDelete || isUpdate) && !/\bwhere\b/i.test(sql)) {
    refuse("it is an unscoped DELETE/UPDATE on an identity table — no WHERE clause at all.");
  }

  // 3. A LIKE pattern wide enough to catch a reserved id. This is the one that catches a
  //    teardown pattern widened later by someone who never heard of these accounts.
  for (const pat of likePatterns(sql)) {
    let re;
    try { re = likeToRegExp(pat); } catch { continue; }
    const hit = RESERVED_SAMPLES.find((id) => re.test(id));
    if (hit) refuse(`its LIKE pattern '${pat}' matches the reserved identity "${hit}".`);
  }
}

/**
 * Wrap a `pg` client so every statement is checked on the way past. Returns a proxy; the
 * original is untouched.
 *
 * @template T
 * @param {T} client
 * @param {string} [origin]
 * @returns {T}
 */
export function guardClient(client, origin = "the test suite") {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "query" || typeof value !== "function") return value;
      return function query(config, values, cb) {
        const sql = typeof config === "string" ? config : config?.text;
        const params = Array.isArray(values) ? values : (typeof config === "object" ? config?.values : undefined);
        assertTestOwnedMutation(sql, params ?? [], origin);
        return value.call(target, config, values, cb);
      };
    },
  });
}
