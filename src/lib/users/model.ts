// The permission matrix of «المستخدمون والأدوار والصلاحيات» (Figma UR-02b, UR-06, UR-07, UR-08,
// UR-09) as plain data. Pure: shared by the server (which decides) and the pages (which preview).
//
// A CELL is a module's level (sub = null: none | view | edit) or one of its actions (true | false).
// A role is a TEMPLATE of cells; an account's permission document is its role's template with its
// explicit exceptions applied (P-2: role ∪ grants − denies). The document the session applies is
// never computed here — it is the stored one (auth-server.ts). These functions build the document a
// change will store, explain where each effective value comes from, and validate a matrix.
import { ALL_MODULES, buildDefaultPermissions, parsePermissions, type AccessLevel, type Permissions } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/hr/sod";
import { GROUPS, isSensitive, subsOf } from "./catalog";

export type Level = AccessLevel;
export type ModuleCells = { access: Level; sub: Record<string, boolean> };
export type Cells = Record<string, ModuleCells>;
export type CellRef = { module: string; sub: string | null };
export type CellValue = string; // "none" | "view" | "edit" for a module, "true" | "false" for an action

const LEVELS: Level[] = ["none", "view", "edit"];
const rank = (l: string) => LEVELS.indexOf(l as Level);

export const cellKey = (c: CellRef) => (c.sub === null ? c.module : `${c.module}.${c.sub}`);
export function parseCellKey(key: string): CellRef | null {
  const [module, sub, extra] = key.split(".");
  if (!module || extra !== undefined || !(ALL_MODULES as readonly string[]).includes(module)) return null;
  if (sub === undefined) return { module, sub: null };
  return subsOf(module).includes(sub) ? { module, sub } : null;
}

/** Every module and every action of the model, with a value (absent = none / false). */
export function normalize(p: Permissions | null | undefined): Cells {
  const out: Cells = {};
  for (const m of ALL_MODULES) {
    const mod = p?.[m];
    const level = typeof mod?.access === "string" && LEVELS.includes(mod.access as Level) ? (mod.access as Level) : "none";
    const sub: Record<string, boolean> = {};
    for (const s of subsOf(m)) sub[s] = mod?.sub?.[s] === true;
    out[m] = { access: level, sub };
  }
  return out;
}

/** The stored form of a matrix: every module states its level and every action its value. */
export function toDocument(c: Cells): Permissions {
  const out: Permissions = {};
  for (const m of ALL_MODULES) {
    const subs = subsOf(m);
    out[m] = subs.length ? { access: c[m].access, sub: { ...c[m].sub } } : { access: c[m].access };
  }
  return out;
}

export function getCell(c: Cells, ref: CellRef): CellValue {
  return ref.sub === null ? c[ref.module].access : String(c[ref.module].sub[ref.sub] === true);
}

export function setCell(c: Cells, ref: CellRef, value: CellValue): void {
  if (ref.sub === null) c[ref.module].access = value as Level;
  else c[ref.module].sub[ref.sub] = value === "true";
}

export function validValue(ref: CellRef, value: unknown): value is CellValue {
  return ref.sub === null ? typeof value === "string" && LEVELS.includes(value as Level) : value === "true" || value === "false";
}

export function allCells(): CellRef[] {
  const out: CellRef[] = [];
  for (const m of ALL_MODULES) {
    out.push({ module: m, sub: null });
    for (const s of subsOf(m)) out.push({ module: m, sub: s });
  }
  return out;
}

/** A value above the role's is a grant; below it, a deny (P-2). */
export function effectOf(ref: CellRef, value: CellValue, roleValue: CellValue): "GRANT" | "DENY" | null {
  if (value === roleValue) return null;
  if (ref.sub === null) return rank(value) > rank(roleValue) ? "GRANT" : "DENY";
  return value === "true" ? "GRANT" : "DENY";
}

export type CellChange = { module: string; sub: string | null; from: CellValue; to: CellValue };
export function diffCells(a: Cells, b: Cells): CellChange[] {
  const out: CellChange[] = [];
  for (const ref of allCells()) {
    const from = getCell(a, ref);
    const to = getCell(b, ref);
    if (from !== to) out.push({ module: ref.module, sub: ref.sub, from, to });
  }
  return out;
}

/**
 * Matrix rules, refused by the server and shown by the editor (UR-S12): an action enabled while its
 * module is «لا وصول» does nothing — the model ignores it — so it is an error, not a silent no-op.
 */
export function matrixErrors(c: Cells): { module: string; sub: string; code: "SUB_WITHOUT_MODULE" }[] {
  const out: { module: string; sub: string; code: "SUB_WITHOUT_MODULE" }[] = [];
  for (const m of ALL_MODULES) {
    if (c[m].access !== "none") continue;
    for (const [s, on] of Object.entries(c[m].sub)) if (on) out.push({ module: m, sub: s, code: "SUB_WITHOUT_MODULE" });
  }
  return out;
}

/** The sensitive cells a matrix turns on (P-3). */
export function sensitiveOn(c: Cells): CellRef[] {
  return allCells().filter((ref) => isSensitive(ref.module, ref.sub) && (ref.sub === null ? c[ref.module].access !== "none" : c[ref.module].access !== "none" && c[ref.module].sub[ref.sub] === true));
}

/** The same matrix with every sensitive cell turned off (a copied template, P-3). */
export function withoutSensitive(c: Cells): Cells {
  const out = structuredClone(c);
  for (const ref of allCells()) {
    if (!isSensitive(ref.module, ref.sub)) continue;
    if (ref.sub === null) { out[ref.module].access = "none"; for (const s of Object.keys(out[ref.module].sub)) out[ref.module].sub[s] = false; }
    else out[ref.module].sub[ref.sub] = false;
  }
  return out;
}

/**
 * The template an account's role gives: a custom role's document, or the system template of the
 * role key («custom» with no custom role = «بلا وصول»). The SAME rule the session applies to a role
 * with no stored document (effectivePermissions), so the admin template is every permission.
 */
export function templateCells(role: string, accessRolePermissions?: string | null): Cells {
  if (accessRolePermissions != null) return normalize(parsePermissions(accessRolePermissions));
  return normalize(effectivePermissions(JSON.stringify(buildDefaultPermissions(role)), role));
}

/**
 * The stored document as cells — what a change writes back. The role's defaults stand in for an
 * empty document (as the session reads it), but SIMPLE MODE's admin widening is not applied: that
 * is how the session READS an admin, never something to store.
 */
export function storedCells(stored: string | null | undefined, role: string): Cells {
  const p = stored == null ? null : parsePermissions(stored);
  return normalize(p && typeof p === "object" && Object.keys(p).length > 0 ? p : buildDefaultPermissions(role));
}

/** What the session applies for a stored document and role (sod.effectivePermissions), as cells. */
export function effectiveCells(stored: string | null | undefined, role: string): Cells {
  return normalize(effectivePermissions(stored ?? null, role));
}

export type OverrideLike = { module: string; sub: string | null; effect: string; value: string; roleValue: string; reason: string; expiresAt: Date | string | null; reviewAt?: Date | string | null; endedAt: Date | string | null; endReason?: string | null; createdAt?: Date | string; createdByName?: string | null; sensitive?: boolean; id?: string };

/** An exception still in force (not ended, and not past its expiry even if not yet settled). */
export function overrideActive(o: Pick<OverrideLike, "endedAt" | "expiresAt">, now = Date.now()): boolean {
  return !o.endedAt && (!o.expiresAt || new Date(o.expiresAt).getTime() > now);
}

/** A template with exceptions applied: role ∪ grants − denies (P-2). */
export function applyOverrides(template: Cells, overrides: Pick<OverrideLike, "module" | "sub" | "value" | "endedAt" | "expiresAt">[], now = Date.now()): Cells {
  const out = structuredClone(template);
  for (const o of overrides) {
    if (!overrideActive(o, now)) continue;
    const ref = { module: o.module, sub: o.sub };
    if (!out[o.module] || (ref.sub !== null && !(ref.sub in out[o.module].sub))) continue;
    setCell(out, ref, o.value);
  }
  return out;
}

export type Source = "role" | "grant" | "deny" | "expired";
export type EffRow = {
  module: string; sub: string | null; value: CellValue; roleValue: CellValue; source: Source; sensitive: boolean;
  /** The exception behind the value (or the last one that ended, for «expired»). */
  override?: { id?: string; reason: string; expiresAt: string | null; reviewAt: string | null; createdAt?: string; createdByName?: string | null; recorded: boolean } | null;
};
export type EffGroup = { key: string; ar: string; en: string; open: boolean; modules: { row: EffRow; subs: EffRow[] }[] };

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * Where each effective value comes from (UR-08): the role, a grant, a deny, or an exception that
 * ended (the value is the role's again). A value that differs from the role with no exception on
 * record — a permission set before exceptions existed — is still a grant or a deny, marked
 * `recorded: false` («بلا سبب مسجّل»).
 */
export function explain(effective: Cells, template: Cells, overrides: OverrideLike[], now = Date.now()): EffGroup[] {
  const active = overrides.filter((o) => overrideActive(o, now));
  const ended = overrides.filter((o) => !overrideActive(o, now)).sort((a, b) => new Date(b.endedAt ?? b.expiresAt ?? 0).getTime() - new Date(a.endedAt ?? a.expiresAt ?? 0).getTime());
  const row = (ref: CellRef): EffRow => {
    const value = getCell(effective, ref);
    const roleValue = getCell(template, ref);
    const sensitive = isSensitive(ref.module, ref.sub);
    const effect = effectOf(ref, value, roleValue);
    const match = (o: OverrideLike) => o.module === ref.module && (o.sub ?? null) === ref.sub;
    if (effect) {
      const o = active.find((x) => match(x) && x.value === value);
      return { ...ref, value, roleValue, sensitive, source: effect === "GRANT" ? "grant" : "deny", override: o ? { id: o.id, reason: o.reason, expiresAt: iso(o.expiresAt), reviewAt: iso(o.reviewAt), createdAt: iso(o.createdAt) ?? undefined, createdByName: o.createdByName ?? null, recorded: true } : { reason: "", expiresAt: null, reviewAt: null, recorded: false } };
    }
    const last = ended.find(match);
    if (last && last.endReason === "EXPIRED") return { ...ref, value, roleValue, sensitive, source: "expired", override: { id: last.id, reason: last.reason, expiresAt: iso(last.expiresAt), reviewAt: iso(last.reviewAt), recorded: true } };
    return { ...ref, value, roleValue, sensitive, source: "role", override: null };
  };
  return GROUPS.map((g) => {
    const modules = g.modules.map((m) => ({ row: row({ module: m, sub: null }), subs: subsOf(m).map((s) => row({ module: m, sub: s })) }));
    const open = modules.some((x) => x.row.value !== "none" || x.row.source !== "role");
    return { key: g.key, ar: g.ar, en: g.en, open, modules };
  });
}

/** The account differs from its role (Figma «مخصص»): any cell, or an exception in force. */
export function isCustomized(effective: Cells, template: Cells): boolean {
  return diffCells(template, effective).some((c) => c.sub === null || effective[c.module].access !== "none");
}

/** UR-07: a module's level in a role and the number of NON-sensitive actions it grants. */
export function compareCell(c: Cells, module: string): { level: Level; actions: number } {
  const level = c[module].access;
  if (level === "none") return { level, actions: 0 };
  return { level, actions: subsOf(module).filter((s) => c[module].sub[s] && !isSensitive(module, s)).length };
}

/** UR-05 «حساسة»: the sensitive cells a template turns on. */
export function sensitiveCount(c: Cells): number {
  return sensitiveOn(c).length;
}

/**
 * The document a change will store: the role's template, the account's exceptions that stay in
 * force, and the cells the editor set. Returned as cells; the caller stores toDocument(...).
 */
export function composeAccount(template: Cells, keep: Pick<OverrideLike, "module" | "sub" | "value" | "endedAt" | "expiresAt">[], set: { ref: CellRef; value: CellValue }[], now = Date.now()): Cells {
  const out = applyOverrides(template, keep, now);
  for (const x of set) setCell(out, x.ref, x.value);
  return out;
}

/** Counted actions in Arabic (UR-07): «إجراء واحد», «إجراءان», «3 إجراءات», «11 إجراءً». */
export function actionsWord(n: number, lang: "ar" | "en" = "ar"): string {
  if (lang === "en") return n === 1 ? "1 action" : `${n} actions`;
  if (n === 1) return "إجراء واحد";
  if (n === 2) return "إجراءان";
  return n <= 10 ? `${n} إجراءات` : `${n} إجراءً`;
}

/** «مستخدم واحد», «مستخدمان», «3 مستخدمين», «11 مستخدمًا». */
export function usersWord(n: number, lang: "ar" | "en" = "ar"): string {
  if (lang === "en") return n === 1 ? "1 user" : `${n} users`;
  if (n === 1) return "مستخدم واحد";
  if (n === 2) return "مستخدمان";
  return n <= 10 ? `${n} مستخدمين` : `${n} مستخدمًا`;
}

/** The editor's change to a working copy (UR-02b / UR-06): «تعديل» never ticks actions (P-3); «لا وصول» clears them. */
export function applyEdit(c: Cells, module: string, sub: string | null, v: string): Cells {
  const out = structuredClone(c);
  if (sub === null) {
    out[module].access = v as Level;
    if (v === "none") for (const s of Object.keys(out[module].sub)) out[module].sub[s] = false;
  } else out[module].sub[sub] = v === "true";
  return out;
}

/** The unsaved cells of a working copy: module levels, and the actions of modules left open. */
export function changedCells(value: Cells, original: Cells): { key: string; module: string; sub: string | null; from: string; to: string }[] {
  const out: { key: string; module: string; sub: string | null; from: string; to: string }[] = [];
  for (const g of GROUPS) for (const m of g.modules) {
    if (value[m].access !== original[m].access) out.push({ key: m, module: m, sub: null, from: original[m].access, to: value[m].access });
    for (const s of subsOf(m)) {
      const a = original[m].sub[s] === true, b = value[m].sub[s] === true;
      if (a !== b && (b || value[m].access !== "none")) out.push({ key: `${m}.${s}`, module: m, sub: s, from: String(a), to: String(b) });
    }
  }
  return out;
}
