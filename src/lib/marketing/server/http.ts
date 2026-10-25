import "server-only";
import { NextResponse } from "@/lib/api-response";
import { requireModule, requireSub, requireAnySub } from "@/lib/auth-server";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import type { SessionUser } from "@/lib/auth-server";
import { lastDays } from "../kpi";

/**
 * The marketing API's shared plumbing: who the caller is, and one shape for every refusal.
 *
 * Marketing answers Arabic-first (as HR does): `error` is the Arabic the screen shows, `errorEn` the
 * English, `code` a stable key for tests. Services throw MktError; `route()` turns it into the
 * response, and turns an unexpected failure into a 500 that names nothing internal.
 */
export class MktError extends Error {
  constructor(public ar: string, public en: string, public status = 400, public code = "MKT_INVALID") {
    super(en);
  }
}

export type Actor = { id: string; name: string; permissions: Permissions; role: string };

export function actorOf(user: SessionUser): Actor {
  return { id: user.id, name: user.name, permissions: user.permissions, role: user.role };
}

export function can(actor: Actor | SessionUser, sub: string): boolean {
  return hasSubPrivilege(actor.permissions, "marketing", sub);
}

/** Viewer of the module, or holder of a specific key (privileged keys pass the privileged gate). */
export async function mktAuth(sub?: string | string[]) {
  if (!sub) return requireModule("marketing");
  if (Array.isArray(sub)) return requireAnySub("marketing", sub);
  return requireSub("marketing", sub);
}

export function fail(e: unknown) {
  if (e instanceof MktError) return NextResponse.json({ error: e.ar, errorEn: e.en, code: e.code }, { status: e.status });
  const code = (e as { code?: string })?.code;
  if (code === "P2002") return NextResponse.json({ error: "يوجد سجل بنفس القيمة الفريدة.", errorEn: "A record with the same unique value exists.", code: "MKT_DUPLICATE" }, { status: 409 });
  if (code === "P2025") return NextResponse.json({ error: "السجل غير موجود.", errorEn: "Record not found.", code: "MKT_NOT_FOUND" }, { status: 404 });
  console.error("[marketing]", e instanceof Error ? `${e.name}: ${e.message}` : e);
  return NextResponse.json({ error: "تعذر إكمال العملية. لم يُحفظ شيء.", errorEn: "The operation failed. Nothing was saved.", code: "MKT_INTERNAL" }, { status: 500 });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const v = await req.json();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new MktError("صيغة الطلب غير صالحة.", "Invalid JSON body.", 400, "MKT_BAD_JSON");
  }
}

export const notFound = () => new MktError("السجل غير موجود.", "Not found.", 404, "MKT_NOT_FOUND");
export const denied = (ar = "لا تملك صلاحية هذا الإجراء.") => new MktError(ar, "Insufficient permissions.", 403, "MKT_FORBIDDEN");

// ── Field readers: refuse rather than coerce ──────────────────────────────────────────────

export function str(v: unknown, label: string, opts: { max?: number; required?: boolean } = {}): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (opts.required) throw new MktError(`الحقل «${label}» مطلوب.`, `${label} is required.`, 400, "MKT_REQUIRED");
    return null;
  }
  if (typeof v !== "string") throw new MktError(`الحقل «${label}» يجب أن يكون نصاً.`, `${label} must be text.`);
  const t = v.trim();
  if (opts.max && t.length > opts.max) throw new MktError(`الحقل «${label}» أطول من ${opts.max} حرفاً.`, `${label} is too long.`);
  return t;
}

export function num(v: unknown, label: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n)) throw new MktError(`الحقل «${label}» يجب أن يكون رقماً.`, `${label} must be a number.`);
  if (opts.int && !Number.isInteger(n)) throw new MktError(`الحقل «${label}» يجب أن يكون عدداً صحيحاً.`, `${label} must be an integer.`);
  if (opts.min !== undefined && n < opts.min) throw new MktError(`الحقل «${label}» أقل من المسموح.`, `${label} is below the minimum.`);
  if (opts.max !== undefined && n > opts.max) throw new MktError(`الحقل «${label}» أكبر من المسموح.`, `${label} is above the maximum.`);
  return n;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  if ((v === undefined || v === null || v === "") && fallback !== undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new MktError(`قيمة «${label}» غير صالحة.`, `Invalid ${label}.`);
}

export function date(v: unknown, label: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new MktError(`تاريخ «${label}» غير صالح.`, `Invalid ${label}.`);
  return d;
}

export function strList(v: unknown, label: string, max = 50): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new MktError(`«${label}» يجب أن تكون قائمة نصوص.`, `${label} must be a list of text.`);
  const out = [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
  if (out.length > max) throw new MktError(`«${label}» تتجاوز ${max} عنصراً.`, `${label} has too many items.`);
  return out;
}

export function url(v: unknown, label: string): string | null {
  const s = str(v, label, { max: 2000 });
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return u.toString();
  } catch {
    throw new MktError(`الرابط «${label}» غير صالح.`, `${label} is not a valid URL.`);
  }
}

/** Decimal → number for JSON (amounts here are SAR with 2 places; never used for ledger arithmetic). */
export function dn(v: { toString(): string } | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v.toString());
}

type RouteCtx<P> = { params: Promise<P> };

/**
 * One route handler: authenticate (module, or a key / any of keys), run, answer JSON. `fn` returns
 * the body, or a Response when it needs another shape (a file, a redirect).
 */
export function route<P = Record<string, never>>(sub: string | string[] | undefined, fn: (req: Request, c: { actor: Actor; user: SessionUser; params: P }) => Promise<unknown>) {
  return async (req: Request, ctx: RouteCtx<P>) => {
    const { user, error } = await mktAuth(sub);
    if (error) return error;
    try {
      const params = (await ctx?.params) ?? ({} as P);
      const out = await fn(req, { actor: actorOf(user), user, params });
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return fail(e);
    }
  };
}

export function qp(req: Request) {
  return new URL(req.url).searchParams;
}

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (to exclusive end-of-day), defaulting to the last `days` days. */
export function rangeOf(req: Request, days = 30): { from: Date; to: Date } {
  const q = qp(req);
  // Whole Riyadh days, `to` exclusive: an explicit ?to= day is included up to its end; without one the window is the
  // last `days` days ending today (lastDays) — so a period and its previous one are the same length and share no day.
  const def = lastDays(days);
  const to = q.get("to") ? new Date(new Date(`${q.get("to")}T00:00:00+03:00`).getTime() + 86_400_000) : def.to;
  const from = q.get("from") ? new Date(`${q.get("from")}T00:00:00+03:00`) : q.get("to") ? new Date(to.getTime() - days * 86_400_000) : def.from;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new MktError("نطاق التاريخ غير صالح.", "Invalid date range.");
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new MktError("النطاق أطول من 400 يوم.", "Range too long.");
  return { from, to };
}

export const WEBHOOK_MAX_BYTES = 1_000_000;

/**
 * A webhook body read up to `max` bytes: refused on its declared Content-Length first, then while streaming —
 * an oversized (or lying) sender never makes the server buffer more than `max`. null = too large.
 */
export async function readCappedBody(req: Request, max = WEBHOOK_MAX_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
