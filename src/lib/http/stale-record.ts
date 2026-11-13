/**
 * P2 ERR-06: the same record open in two tabs (or by two people) — the second save used to put back the values the first
 * had changed, silently.
 *
 * Gate round 1 (E1) made it FIELD-LEVEL and ATOMIC:
 *   · a form sends the `updatedAt` it was loaded with (`expectedUpdatedAt`) and, for the fields it sends, the values it
 *     was loaded with (`baseline`);
 *   · the record unchanged since → the save goes through as sent;
 *   · changed since → per field: a field the form did not change (sent = baseline) is DROPPED (the other change stays);
 *     a field the form changed that nobody else touched is written; a field changed on both sides to different values
 *     is a conflict → 409 STALE_RECORD naming the fields, nothing written. Different fields merge.
 *   · the write itself is conditional on the `updatedAt` read (`updateMany … where updatedAt = read`): two saves racing
 *     from the same copy → one is written, the other gets the 409.
 *   · the screens always send the version: a BROWSER request without it is refused (400 VERSION_REQUIRED) — see
 *     versionRequired. A script / server-to-server caller (no Sec-Fetch-Site) is not a form and saves as before.
 */
const STALE_AR = "السجل تغيّر من مكان ثاني بعد ما فتحته — حدّث الصفحة وعدّل من جديد.";
const STALE_EN = "The record changed elsewhere after you opened it — reload and edit again.";

export function staleRefusal(current: Date, fields?: string[]) {
  return {
    _appCode: 409, code: "STALE_RECORD", message: STALE_AR, error: STALE_AR, errorAr: STALE_AR, errorEn: STALE_EN,
    updatedAt: current.toISOString(), ...(fields?.length ? { fields } : {}),
  };
}

/** Kept for callers that compare versions only (no field merge). */
export function staleRecordRefusal(expected: unknown, current: Date | null | undefined) {
  if (typeof expected !== "string" || !expected || !current) return null;
  const e = new Date(expected);
  if (Number.isNaN(e.getTime()) || e.getTime() === current.getTime()) return null;
  return staleRefusal(current);
}

/** A form's save from the browser must carry the version it was loaded with (gate E1: required on the UI paths). */
export function versionRequired(request: Request, expected: unknown) {
  if (typeof expected === "string" && expected) return null;
  // Browsers always send Sec-Fetch-Site on fetch (a forbidden header: page code can neither drop nor fake it); Node's fetch,
  // curl and server-to-server callers do not — they are not a form, and save as before.
  if (!request.headers.get("sec-fetch-site")) return null;
  const ar = "حدّث الصفحة ثم احفظ — نسخة السجل ناقصة.";
  return { _appCode: 400, code: "VERSION_REQUIRED", message: ar, error: ar, errorAr: ar, errorEn: "Reload the page and save again — the record version is missing." };
}

const norm = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v !== null && "toFixed" in v) return String(Number(String(v))); // Prisma Decimal
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return s;
};
const same = (a: unknown, b: unknown) => norm(a) === norm(b);

const META = new Set(["id", "createdAt", "updatedAt"]);

export type MergeResult = { ok: true; dropped: string[] } | { ok: false; refusal: ReturnType<typeof staleRefusal> };

/**
 * Field-level merge of a save against the record as stored now. Mutates `sent`: the fields the form did not change are
 * removed when the record moved on (so the other change is kept). `current` is the full stored row.
 */
export function mergeAgainst(sent: Record<string, unknown>, opts: { expected: unknown; baseline: unknown; current: Record<string, unknown> & { updatedAt: Date } }): MergeResult {
  const { expected, baseline, current } = opts;
  if (typeof expected !== "string" || !expected) return { ok: true, dropped: [] };
  const e = new Date(expected);
  if (Number.isNaN(e.getTime()) || e.getTime() === current.updatedAt.getTime()) return { ok: true, dropped: [] };
  const base = baseline && typeof baseline === "object" && !Array.isArray(baseline) ? (baseline as Record<string, unknown>) : null;
  const columns = Object.keys(sent).filter((k) => !META.has(k) && Object.prototype.hasOwnProperty.call(current, k));
  if (!base) return { ok: false, refusal: staleRefusal(current.updatedAt) };
  const dropped: string[] = [];
  const conflicts: string[] = [];
  for (const k of columns) {
    if (!Object.prototype.hasOwnProperty.call(base, k)) { conflicts.push(k); continue; }
    const s = sent[k], b = base[k], c = current[k];
    if (same(s, b)) { dropped.push(k); continue; }        // not changed by this form → keep what is stored
    if (same(c, b) || same(s, c)) continue;                // only this form changed it (or both to the same value)
    conflicts.push(k);                                     // changed on both sides, differently
  }
  if (conflicts.length) return { ok: false, refusal: staleRefusal(current.updatedAt, conflicts) };
  for (const k of dropped) delete sent[k];
  return { ok: true, dropped };
}

/** The values a form was loaded with, for the fields it sends (the client half of mergeAgainst). */
export function baselineOf(record: Record<string, unknown> | null | undefined, body: Record<string, unknown>): Record<string, unknown> {
  if (!record) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (k !== "expectedUpdatedAt" && k !== "baseline" && Object.prototype.hasOwnProperty.call(record, k)) out[k] = record[k] ?? null;
  return out;
}
