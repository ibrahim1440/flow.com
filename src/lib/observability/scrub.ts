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

/** Mask anything that could identify a person or carry a credential. Idempotent. */
export function scrubText(s: string): string {
  return s
    .replace(QUERY, "$1")
    .replace(BEARER, (_m, k: string, sep: string) => `${k}${sep}[redacted]`)
    .replace(EMAIL, "[email]")
    .replace(IBAN, "[iban]")
    .replace(PHONE, "[phone]")
    .replace(LONG_DIGITS, "[number]");
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

export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  delete event.user;
  if (event.request) {
    const url = typeof event.request.url === "string" ? scrubText(event.request.url.split("?")[0]) : undefined;
    event.request = { ...(url ? { url } : {}), ...(event.request.method ? { method: event.request.method } : {}) };
  }
  if (typeof event.message === "string") event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) if (typeof ex.value === "string") ex.value = scrubText(ex.value);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((b): b is NonNullable<typeof b> => !!b);
  if (event.extra) event.extra = scrubDeep(event.extra);
  if (event.contexts) event.contexts = scrubDeep(event.contexts);
  // R1-d gate L2: tags are free text too (a route's or a library's) — scrubbed like the rest.
  if (event.tags) event.tags = scrubDeep(event.tags);
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
    tracesSampleRate: 0,
    beforeSend: <E extends ScrubbableEvent>(e: E) => scrubEvent(e),
    beforeBreadcrumb: <B extends { message?: string; data?: unknown; category?: string }>(b: B) => scrubBreadcrumb(b),
  };
}
