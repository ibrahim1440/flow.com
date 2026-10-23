// «سجل الصلاحيات» — the words (pure; no database).
// (Figma UR-12, 607:4125 / 613:6323 / 616:7307) — the read side of AuthAuditLog for
// the users area: every change to accounts, roles, permissions and credentials, and sign-in events.
// Absolute Asia/Riyadh times, the actor, the action, the target, the source, the details and — for
// a permission change — the expandable before / after of each key with the reason. No secret is in
// the log to begin with (employee-audit.ts); the export (O-6) is a sensitive action, itself audited.
import type { Prisma } from "@/generated/prisma/client";
import { moduleLabel, subLabel, LEVEL_AR, SYSTEM_ROLES, NO_ACCESS_ROLE } from "./catalog";

export type AuditCategory = "all" | "permissions" | "accounts" | "signin";
type Def = { ar: string; en: string; cat: Exclude<AuditCategory, "all"> };

/** Every action the log shows, with its words (UR-12 «الإجراء»). Anything else is not listed here. */
export const AUDIT_ACTIONS: Record<string, Def> = {
  EMPLOYEE_PERMISSIONS_CHANGED: { ar: "غيّر الصلاحيات", en: "Changed permissions", cat: "permissions" },
  EMPLOYEE_ROLE_CHANGED: { ar: "غيّر دور المستخدم", en: "Changed the user's role", cat: "permissions" },
  PERMISSION_OVERRIDE_EXPIRED: { ar: "انتهى استثناء", en: "Exception expired", cat: "permissions" },
  ROLE_CREATED: { ar: "أنشأ دورًا", en: "Created a role", cat: "permissions" },
  ROLE_UPDATED: { ar: "غيّر الدور", en: "Changed a role", cat: "permissions" },
  EMPLOYEE_CREATED: { ar: "أنشأ مستخدمًا", en: "Created a user", cat: "accounts" },
  EMPLOYEE_DEACTIVATED: { ar: "أوقف", en: "Revoked access", cat: "accounts" },
  EMPLOYEE_ACTIVATED: { ar: "أعاد التفعيل", en: "Reactivated", cat: "accounts" },
  EMPLOYEE_DELETED: { ar: "حذف الحساب", en: "Deleted the account", cat: "accounts" },
  EMPLOYEE_CREDENTIAL_CHANGED: { ar: "غيّر بيانات الدخول", en: "Changed credentials", cat: "accounts" },
  ACCOUNT_UNLOCKED: { ar: "فتح القفل", en: "Unlocked", cat: "accounts" },
  SESSION_ENDED_ADMIN: { ar: "أنهى جلسة", en: "Ended a session", cat: "accounts" },
  DEVICE_SESSIONS_ENDED_ADMIN: { ar: "ألغى الثقة بجهاز", en: "Revoked a device", cat: "accounts" },
  SESSIONS_ENDED_ADMIN: { ar: "أنهى كل الجلسات", en: "Ended all sessions", cat: "accounts" },
  AUDIT_EXPORTED: { ar: "صدّر سجل الصلاحيات", en: "Exported the log", cat: "accounts" },
  // feat/credit-hold: the company e-mail of an account (its HR person's, or its own).
  EMPLOYEE_COMPANY_EMAIL_CHANGED: { ar: "غيّر بريد الشركة", en: "Changed the company e-mail", cat: "accounts" },
  PASSWORD_CHANGED_SELF: { ar: "غيّر كلمة مروره", en: "Changed own password", cat: "signin" },
  SIGN_IN: { ar: "سجّل دخولًا", en: "Signed in", cat: "signin" },
  MFA_SIGN_IN: { ar: "سجّل دخولًا", en: "Signed in", cat: "signin" },
  SIGN_OUT: { ar: "سجّل خروجًا", en: "Signed out", cat: "signin" },
  // Workstations W2 (20261027090000_station_w2): station devices, access and the station PIN.
  STATION_CREATED: { ar: "أضاف محطة", en: "Added a station", cat: "accounts" },
  STATION_UPDATED: { ar: "عدّل محطة", en: "Changed a station", cat: "accounts" },
  STATION_REGISTERED: { ar: "سجّل جهاز محطة", en: "Registered a station device", cat: "accounts" },
  STATION_CODE_ISSUED: { ar: "أصدر رمز تفعيل", en: "Issued an activation code", cat: "accounts" },
  STATION_CODE_CANCELLED: { ar: "ألغى رمز التفعيل", en: "Cancelled an activation code", cat: "accounts" },
  STATION_ACTIVATED: { ar: "فُعّل جهاز محطة", en: "Station device activated", cat: "accounts" },
  STATION_REVOKED: { ar: "ألغى جهاز محطة", en: "Revoked a station device", cat: "accounts" },
  STATION_POLICY_CHANGED: { ar: "غيّر سياسة المحطات", en: "Changed the station policy", cat: "accounts" },
  STATION_ACCESS_CHANGED: { ar: "غيّر الوصول إلى المحطات", en: "Changed station access", cat: "permissions" },
  STATION_PIN_SET: { ar: "عيّن رمز المحطة", en: "Set the station PIN", cat: "signin" },
  STATION_PIN_REENABLED: { ar: "أعاد تفعيل رمز المحطة", en: "Re-enabled the station PIN", cat: "accounts" },
  STATION_SIGN_IN: { ar: "دخل من محطة", en: "Signed in at a station", cat: "signin" },
  STATION_SIGN_OUT: { ar: "خرج من محطة", en: "Signed out at a station", cat: "signin" },
  STATION_SWITCH: { ar: "بدّل الموظف في محطة", en: "Switched employee at a station", cat: "signin" },
  STATION_PIN_FAILED: { ar: "رمز محطة غير صحيح", en: "Wrong station PIN", cat: "signin" },
  STATION_PIN_LOCKED: { ar: "قُفل رمز المحطة", en: "Station PIN locked", cat: "signin" },
};

const SOURCE: Record<string, { ar: string; en: string }> = { WEB: { ar: "ويب", en: "Web" }, STATION: { ar: "محطة", en: "Station" }, SYSTEM: { ar: "النظام", en: "System" } };
const METHOD_AR: Record<string, string> = { PASSWORD: "بكلمة المرور", USERNAME_PIN: "باسم المستخدم والرمز", PIN: "بالرمز" };

export type AuditFilters = { q?: string; cat?: AuditCategory; days?: number | null; source?: "all" | "web" | "station" | "system"; before?: string | null; take?: number };

export function parseFilters(sp: URLSearchParams | Record<string, unknown>): AuditFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) : (sp[k] as string | null | undefined)) ?? null;
  const cat = get("cat");
  const days = get("days");
  const source = get("source");
  return {
    q: (get("q") ?? "").trim().slice(0, 80),
    cat: cat === "permissions" || cat === "accounts" || cat === "signin" ? cat : "all",
    days: days === "all" ? null : [7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30,
    source: source === "web" || source === "station" || source === "system" ? source : "all",
    before: get("before"),
  };
}

const cellName = (path: string, lang: "ar" | "en" = "ar") => {
  const [m, k] = path.split(".");
  if (k === "access") return moduleLabel(m, lang);
  return subLabel(m, k, lang);
};
const valueWord = (path: string, v: unknown) => {
  if (path.endsWith(".access")) return LEVEL_AR[String(v)] ?? (v === null ? "—" : String(v));
  return v === true ? "مسموح" : v === false ? "غير مسموح" : "—";
};
const roleName = (key: unknown) => (typeof key === "string" ? SYSTEM_ROLES.find((r) => r.key === key)?.ar ?? (key === "custom" ? NO_ACCESS_ROLE.ar : key) : "—");
const day = (iso: string) => new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { day: "numeric", month: "long", timeZone: "Asia/Riyadh" }).format(new Date(iso));

export type AuditEntry = {
  id: string; at: string; actor: string; actorId: string | null; action: string; label: string; labelEn: string; cat: string; result: string;
  target: string; targetId: string | null; source: string; details: string; reason: string | null;
  diff: { key: string; label: string; before: string; after: string }[] | null;
};

/** One row in the screen's words. Never reads a credential: the log holds none. */
export type Row = { id: string; userId: string | null; action: string; result: string; reasonCode: string | null; sourceInterface: string; metadata: Prisma.JsonValue; occurredAt: Date };

export function describe(r: Row, names: Map<string, string>): AuditEntry {
  const m = (r.metadata ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form audit metadata, read field by field
  const def = AUDIT_ACTIONS[r.action] ?? { ar: r.action, en: r.action, cat: "accounts" };
  const actor = r.userId ? names.get(r.userId) ?? "—" : "النظام";
  let label = def.ar;
  let target = typeof m.targetName === "string" ? m.targetName : m.targetEmployeeId ? names.get(m.targetEmployeeId) ?? "—" : "—";
  let details = "";
  let diff: AuditEntry["diff"] = null;
  const reason = typeof m.reason === "string" ? m.reason : null;
  switch (r.action) {
    case "SIGN_IN": case "MFA_SIGN_IN": {
      target = actor;
      if (r.result === "SUCCESS") details = METHOD_AR[String(m.method ?? r.reasonCode ?? "")] ?? (r.action === "MFA_SIGN_IN" ? "بالتحقق بخطوتين" : "");
      else { label = r.result === "REFUSED" ? "رُفض الدخول" : "محاولة دخول فاشلة"; details = r.reasonCode === "TEMP_PASSWORD_EXPIRED" ? "كلمة مرور مؤقتة منتهية" : METHOD_AR[String(r.reasonCode ?? "")] ?? ""; }
      break;
    }
    case "SIGN_OUT": target = actor; break;
    case "PASSWORD_CHANGED_SELF": target = actor; break;
    case "EMPLOYEE_CREATED":
      details = [`الدور: ${roleName(m.role)}`, m.temporaryPassword ? "كلمة مرور مؤقتة" : null, m.hrLinked ? "مرتبط بملف الموظف" : null].filter(Boolean).join(" · ");
      break;
    case "EMPLOYEE_ROLE_CHANGED":
      details = `${roleName(m.oldRole)} ← ${roleName(m.newRole)}`;
      break;
    case "EMPLOYEE_PERMISSIONS_CHANGED": case "PERMISSION_OVERRIDE_EXPIRED": {
      const changes = (Array.isArray(m.changes) ? m.changes : []) as { path: string; from: unknown; to: unknown }[];
      const overrides = (Array.isArray(m.overrides) ? m.overrides : []) as { cell: string; effect: string; value: string }[];
      const until = typeof m.expiresAt === "string" ? ` حتى ${day(m.expiresAt)}` : "";
      if (r.action === "PERMISSION_OVERRIDE_EXPIRED") {
        const items = (Array.isArray(m.overrides) ? m.overrides : []) as { module: string; sub: string | null; restored: boolean }[];
        details = items.map((o) => `«${o.sub ? subLabel(o.module, o.sub) : moduleLabel(o.module)}»${o.restored ? " · عاد إلى قيمة الدور" : ""}`).join(" · ") || "تلقائيًا عند تاريخ الانتهاء";
      } else if (overrides.length) {
        details = overrides.map((o) => {
          const [mod, sub] = o.cell.split(".");
          const name = sub ? subLabel(mod, sub) : `${moduleLabel(mod)} · ${LEVEL_AR[o.value] ?? o.value}`;
          return o.effect === "GRANT" ? `منح «${name}»${until}` : `منع «${name}»`;
        }).join(" · ");
      } else {
        details = changes.slice(0, 3).map((c) => `${cellName(c.path)}: ${valueWord(c.path, c.from)} ← ${valueWord(c.path, c.to)}`).join(" · ") + (changes.length > 3 ? ` · +${changes.length - 3}` : "");
      }
      if (m.via === "ROLE" && typeof m.roleName === "string") details = `عبر دور «${m.roleName}» · ${details}`;
      diff = changes.map((c) => ({ key: c.path.endsWith(".access") ? c.path : `${c.path.split(".")[0]}.sub.${c.path.split(".")[1]}`, label: cellName(c.path), before: valueWord(c.path, c.from), after: valueWord(c.path, c.to) }));
      break;
    }
    case "ROLE_CREATED": case "ROLE_UPDATED": {
      target = `دور «${m.roleName ?? "—"}»`;
      const changes = (Array.isArray(m.changes) ? m.changes : []) as { path: string; from: unknown; to: unknown }[];
      const added = changes.filter((c) => c.to === true || (c.path.endsWith(".access") && c.to !== "none" && c.to !== null));
      const removed = changes.filter((c) => !added.includes(c));
      details = r.action === "ROLE_CREATED"
        ? (m.basedOn ? `نسخة من ${roleName(m.basedOn)}` : "دور مخصص جديد")
        : [added.length ? `أضاف ${added.slice(0, 2).map((c) => `«${cellName(c.path)}${c.path.endsWith(".access") ? ` · ${valueWord(c.path, c.to)}` : ""}»`).join("، ")}${added.length > 2 ? ` و${added.length - 2} أخرى` : ""}` : null,
           removed.length ? `أزال ${removed.slice(0, 2).map((c) => `«${cellName(c.path)}»`).join("، ")}${removed.length > 2 ? ` و${removed.length - 2} أخرى` : ""}` : null].filter(Boolean).join(" · ");
      if (Array.isArray(m.members) && m.members.length) details += ` · يسري على ${m.members.length === 1 ? "مستخدم واحد" : m.members.length === 2 ? "مستخدمَين" : `${m.members.length} مستخدمين`}`;
      diff = changes.length ? changes.map((c) => ({ key: c.path, label: cellName(c.path), before: valueWord(c.path, c.from), after: valueWord(c.path, c.to) })) : null;
      break;
    }
    case "EMPLOYEE_CREDENTIAL_CHANGED":
      if (m.kind === "TEMPORARY_PASSWORD") { label = "أعاد تعيين كلمة المرور"; details = "كلمة مؤقتة · تُعرض مرة واحدة"; }
      else if (m.kind === "PIN_CLEARED") { label = "أعاد تعيين رمز المحطة"; details = "يعيّن الموظف رمزًا جديدًا بنفسه"; }
      else details = (Array.isArray(m.credentials) ? m.credentials : []).map((c: string) => (c === "pin" ? "الرمز" : c === "password" ? "كلمة المرور" : c)).join(" · ");
      break;
    case "ACCOUNT_UNLOCKED": details = `${m.attemptsCleared ?? 0} محاولات فاشلة مُسحت`; break;
    case "SESSION_ENDED_ADMIN": case "DEVICE_SESSIONS_ENDED_ADMIN": case "SESSIONS_ENDED_ADMIN": details = `${m.sessions ?? 0} جلسات`; break;
    case "AUDIT_EXPORTED": target = "سجل الصلاحيات"; details = `${m.rows ?? 0} سطرًا`; break;
    // Workstations W2: the device or station named, never a PIN, code or token.
    case "STATION_SIGN_IN": case "STATION_SIGN_OUT": case "STATION_SWITCH": case "STATION_PIN_FAILED": case "STATION_PIN_LOCKED": case "STATION_PIN_SET":
      target = actor;
      if (r.action === "STATION_SIGN_IN" && r.result !== "SUCCESS") label = r.reasonCode === "NOT_ASSIGNED" ? "محاولة دخول لمحطة غير مكلّف بها" : r.reasonCode === "ADMIN_ROLE" ? "رُفض دخول المسؤول من محطة" : "رُفض الدخول من محطة";
      details = [m.deviceName, r.reasonCode === "IDLE" ? "خمول" : r.reasonCode === "LOCK" ? "قفل" : null, typeof m.claimsReleased === "number" && m.claimsReleased ? `حُرّرت ${m.claimsReleased} مهمة` : null].filter(Boolean).join(" · ");
      break;
    case "STATION_CREATED": case "STATION_UPDATED": case "STATION_POLICY_CHANGED": target = m.stationName ? `محطة «${m.stationName}»` : "المحطات"; break;
    case "STATION_REGISTERED": case "STATION_CODE_ISSUED": case "STATION_CODE_CANCELLED": case "STATION_ACTIVATED": case "STATION_REVOKED":
      target = m.deviceName ? `جهاز «${m.deviceName}»` : "جهاز محطة"; details = m.stationName ? `المحطة: ${m.stationName}` : ""; break;
    case "STATION_ACCESS_CHANGED": {
      const ch = (Array.isArray(m.changes) ? m.changes : []) as { stationName: string; to: string }[];
      details = ch.map((c) => `${c.stationName}: ${c.to === "NONE" ? "غير مسموح" : c.to === "SUPERVISOR" ? "مسموح · مشرف" : "مسموح"}`).join(" · ");
      break;
    }
  }
  if (reason && !details.includes(reason) && r.action !== "EMPLOYEE_PERMISSIONS_CHANGED" && r.action !== "ROLE_UPDATED") details = details ? `${details} · السبب: ${reason}` : `السبب: ${reason}`;
  return {
    id: r.id, at: r.occurredAt.toISOString(), actor, actorId: r.userId, action: r.action, label, labelEn: def.en, cat: def.cat, result: r.result,
    target, targetId: typeof m.targetEmployeeId === "string" ? m.targetEmployeeId : r.action.startsWith("SIGN") ? r.userId : null,
    source: SOURCE[r.sourceInterface]?.ar ?? r.sourceInterface, details, reason, diff,
  };
}


/** A CSV cell: spreadsheet formulas neutralised (CWE-1236), every cell quoted. */
export const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};
