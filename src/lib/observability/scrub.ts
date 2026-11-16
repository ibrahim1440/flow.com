// R1-d (owner 2-أ): what may leave for Sentry. Errors only — never a name, a national ID, an IBAN, a phone, an e-mail, a
// salary or a request body. Applied to every event (beforeSend) and breadcrumb (beforeBreadcrumb), server and browser.
// Pure (no Sentry import), so it is tested on its own (tests/ui/unit/sentry-scrub.test.ts).

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// R1-d gate L2: in either case (an IBAN typed in lower case is still an IBAN).
// L7: bounded to an IBAN's own shape so it never swallows the word after it — either unbroken (2 letters, 2 check digits,
// 11–30 letters/digits: SA0380000000608010167519) or printed in groups of four separated by single spaces
// (SA03 8000 0000 6080 1016 7519, GB82 WEST 1234 …) — the first group may be a bank code in letters, every later group
// holds a digit (so a following word such as «phone» or «code» is never taken for one).
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4})(?: (?=[A-Z0-9]{0,3}\d)[A-Z0-9]{4}){1,6}(?: (?=[A-Z0-9]{0,2}\d)[A-Z0-9]{1,3})?)\b/gi;
/** A URL's query string inside free text (a breadcrumb's message: «GET /api/x?customer=…»). */
const QUERY = /((?:https?:\/\/|\/)[^\s?#"']*)\?[^\s"'#]*/g;
const PHONE = /(?:\+|00)?9665\d{8}\b|\b05\d{8}\b/g;
const LONG_DIGITS = /\d{6,}/g;
const BEARER = /(bearer|token|secret|password|pin)(["'\s:=]+)[^\s"',;]+/gi;

/**
 * A technical id in hex — a trace id (32), a span id (16) — kept as it is wherever it appears (production check,
 * HIQBAH-ERP-2: the digit mask cut a trace id into «not a valid trace id»). Holds at least one letter a–f, so a plain
 * 16-digit number (a card, an account) is NOT one and is still masked. Bounded so it is never part of a word, an e-mail
 * or a dotted name — and e-mails are masked BEFORE ids are kept (deadbeefcafe1234@example.com is an e-mail, not an id).
 */
const HEX_ID = /(?<![\w.@+-])(?=[0-9a-f]*[a-f])(?:[0-9a-f]{32}|[0-9a-f]{16})(?![\w@.-])/gi;

/** Mask anything that could identify a person or carry a credential. Idempotent. */
export function scrubText(s: string): string {
  const kept: string[] = [];
  return s
    .replace(QUERY, "$1")
    .replace(BEARER, (_m, k: string, sep: string) => `${k}${sep}[redacted]`)
    .replace(EMAIL, "[email]")
    .replace(HEX_ID, (m) => `\u0000${kept.push(m) - 1}\u0000`)
    .replace(IBAN, "[iban]")
    .replace(PHONE, "[phone]")
    .replace(LONG_DIGITS, "[number]")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "");
}

type Json = unknown;
function scrubDeep(v: Json, depth = 0): Json {
  if (depth > 6) return "[depth]";
  if (typeof v === "string") return scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, Json>)) out[k] = /pass|secret|token|cookie|authorization|pin|iban|national|salary/i.test(k) ? "[redacted]" : scrubDeep(x, depth + 1);
    return out;
  }
  return v;
}

/** A Sentry event, structurally (only the parts we touch). */
export type ScrubbableEvent = {
  message?: string;
  user?: unknown;
  request?: { url?: string; method?: string; headers?: unknown; cookies?: unknown; data?: unknown; query_string?: unknown; env?: unknown };
  exception?: { values?: { value?: string; type?: string }[] };
  breadcrumbs?: { message?: string; data?: unknown; category?: string }[];
  extra?: unknown;
  contexts?: unknown;
  tags?: unknown;
};

/**
 * A guest link's secret in a path (production check): /guest-qc/<batch>/<token>, /api/guest-qc/<batch>/<token>,
 * /guest-cupping/session/<token>, /api/public/cupping/session/<token> — and any path segment of 20+ base64url
 * characters (a token in a route this list does not know yet) — read «[token]». Applied to request.url and
 * contexts.nextjs.request_path only.
 */
const TOKEN_ROUTE = [/^(\/(?:api\/)?guest-qc\/[^/]+\/)[^/]+/, /^(\/(?:guest-cupping|api\/public\/cupping)\/session\/)[^/]+/];
export function scrubPath(value: string): string {
  const noQuery = value.split(/[?#]/)[0];
  const m = /^(https?:\/\/[^/]+)?(.*)$/.exec(noQuery)!;
  let path = m[2] || "";
  for (const r of TOKEN_ROUTE) path = path.replace(r, "$1[token]");
  path = path.split("/").map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) ? "[token]" : seg)).join("/");
  return scrubText((m[1] ?? "") + path);
}

/** Tags and contexts that name or locate the person — dropped whatever they hold. */
const PERSON_TAG = /^(user|ip|ip_address|user\.[a-z_]+|geo(\.[a-z_]+)?)$/i;

/**
 * Owner decision 23 = أ (production check HIQBAH-ERP-1, «Geography: Ashburn»): a location the event already carries, so
 * Sentry never looks one up from the address the event arrived from. Read in Relay (getsentry/relay @ ca5ee62e):
 *   · relay-event-normalization/src/event.rs:297 — normalize() calls normalize_user_geoinfo(..., config.client_ip) with
 *     the CONNECTION's IP, whatever user.ip_address says (null included; changelog #4586 made this deliberate);
 *   · event.rs:508-516 — normalize_user_geoinfo returns at once when user.geo is already set (#4888) — the check comes
 *     BEFORE any IP is read, so no lookup happens at all;
 *   · relay-event-schema/src/protocol/user.rs:9-29 — Geo is four optional strings (country_code max 102 chars, no format
 *     check) plus «other»: nothing here is validated against a country list, so "XX" is accepted and raises no error;
 *   · why not {}: user.rs:68 marks geo skip_serialization = "empty" — an empty Geo would still count as set in memory,
 *     but it is dropped wherever the event is re-serialised (an outer Relay forwarding it), and the next Relay would
 *     look the IP up. A non-empty value survives every hop.
 * "XX" is the ISO 3166-1 user-assigned code: it names no country. Behind it, a Sentry rule removes $user.geo.** after
 * the lookup (docs/ops/CRON-AND-MONITORING.md).
 */
export const NEUTRAL_GEO = Object.freeze({ country_code: "XX" });

/**
 * Production check (HIQBAH-ERP-2): scrub by the event's STRUCTURE. Only free text is scrubbed — message, exception
 * values, breadcrumbs, request url (path only), extra, custom tags. Never touched: event_id, contexts (trace ids, React /
 * browser / OS / device / runtime / app versions — except contexts.user and contexts.geo, which are dropped), sdk,
 * release, dist, environment, timestamps, level, platform, stack frames.
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  // Not deleted: { ip_address: null } tells Sentry not to infer the sender's IP (no «user» tag).
  // geo: NEUTRAL_GEO (owner decision 23 = أ) — Relay sets user.geo from the CONNECTION's IP even with ip_address null.
  event.user = { ip_address: null, geo: { ...NEUTRAL_GEO } };
  if (event.request) {
    const url = typeof event.request.url === "string" ? scrubPath(event.request.url) : undefined;
    event.request = { ...(url ? { url } : {}), ...(event.request.method ? { method: event.request.method } : {}) };
  }
  if (typeof event.message === "string") event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) if (typeof ex.value === "string") ex.value = scrubText(ex.value);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((b): b is NonNullable<typeof b> => !!b);
  if (event.extra) event.extra = scrubDeep(event.extra);
  if (event.contexts && typeof event.contexts === "object") {
    const c = { ...(event.contexts as Record<string, unknown>) };
    delete c.user; delete c.geo;
    // The one free-text field among the contexts: the page's path (a guest link's token).
    const nx = c.nextjs as { request_path?: unknown } | undefined;
    if (nx && typeof nx.request_path === "string") c.nextjs = { ...nx, request_path: scrubPath(nx.request_path) };
    event.contexts = c;
  }
  // R1-d gate L2: custom tags are free text — scrubbed; a tag naming or locating the person is dropped.
  if (event.tags && typeof event.tags === "object") {
    const t: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.tags as Record<string, unknown>)) if (!PERSON_TAG.test(k)) t[k] = typeof v === "string" ? scrubText(v) : v;
    event.tags = t;
  }
  return event;
}

export function scrubBreadcrumb<B extends { message?: string; data?: unknown; category?: string }>(b: B): B | null {
  // Console output can carry anything a developer printed: dropped. Network breadcrumbs keep the path only.
  if (b.category === "console") return null;
  const out = { ...b };
  if (typeof out.message === "string") out.message = scrubText(out.message);
  if (out.data && typeof out.data === "object") {
    const d = { ...(out.data as Record<string, unknown>) };
    if (typeof d.url === "string") d.url = scrubText(d.url.split("?")[0]);
    delete d.body; delete d.request_body; delete d.response_body;
    out.data = scrubDeep(d);
  }
  return out;
}

/** The options both runtimes share. */
export function sentryOptions(dsn: string, environment: string | undefined) {
  return {
    dsn,
    environment: environment || "production",
    sendDefaultPii: false,
    // Production check (HIQBAH-ERP-2): in SDK 11 the IP is governed by dataCollection.userInfo (default true) — the
    // browser client then tells Relay infer_ip "auto", which stores the sender's IP and derives its location and a
    // «user» tag, whatever beforeSend does. Off, with every other collection category this application never needs.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      databaseQueryData: false,
    },
    tracesSampleRate: 0,
    beforeSend: <E extends ScrubbableEvent>(e: E) => scrubEvent(e),
    beforeBreadcrumb: <B extends { message?: string; data?: unknown; category?: string }>(b: B) => scrubBreadcrumb(b),
  };
}
