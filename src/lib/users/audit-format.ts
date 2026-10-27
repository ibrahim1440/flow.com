// «سجل الصلاحيات» — the words (pure; no database).
// (Figma UR-12, 607:4125 / 613:6323 / 616:7307) — the read side of AuthAuditLog for
// the users area: every change to accounts, roles, permissions and credentials, and sign-in events.
// Absolute Asia/Riyadh times, the actor, the action, the target, the source, the details and — for
// a permission change — the expandable before / after of each key with the reason. No secret is in
// the log to begin with (employee-audit.ts); the export (O-6) is a sensitive action, itself audited.
import type { Prisma } from "@/generated/prisma/client";
import { moduleLabel, subLabel, LEVEL_AR, LEVEL_EN, SYSTEM_ROLES, NO_ACCESS_ROLE } from "./catalog";

export type AuditCategory = "all" | "permissions" | "accounts" | "signin" | "purchases";
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
  STATION_DEVICE_STATIONS: { ar: "غيّر المحطات التي يخدمها جهاز", en: "Changed the stations a device serves", cat: "accounts" },
  STATION_POLICY_CHANGED: { ar: "غيّر سياسة المحطات", en: "Changed the station policy", cat: "accounts" },
  STATION_ACCESS_CHANGED: { ar: "غيّر الوصول إلى المحطات", en: "Changed station access", cat: "permissions" },
  STATION_PIN_SET: { ar: "عيّن رمز المحطة", en: "Set the station PIN", cat: "signin" },
  STATION_PIN_REENABLED: { ar: "أعاد تفعيل رمز المحطة", en: "Re-enabled the station PIN", cat: "accounts" },
  STATION_SIGN_IN: { ar: "دخل من محطة", en: "Signed in at a station", cat: "signin" },
  STATION_SIGN_OUT: { ar: "خرج من محطة", en: "Signed out at a station", cat: "signin" },
  STATION_SWITCH: { ar: "بدّل الموظف في محطة", en: "Switched employee at a station", cat: "signin" },
  STATION_PIN_FAILED: { ar: "رمز محطة غير صحيح", en: "Wrong station PIN", cat: "signin" },
  STATION_PIN_LOCKED: { ar: "قُفل رمز المحطة", en: "Station PIN locked", cat: "signin" },
  // Unified inventory phase 2: the purchase invoice's activity (src/lib/accounting/ops/purchase-activity.ts).
  PURCHASE_INVOICE_SAVED: { ar: "حفظ فاتورة مشتريات كمسودة", en: "Saved a purchase invoice as draft", cat: "purchases" },
  PURCHASE_INVOICE_SUBMITTED: { ar: "قدّم فاتورة مشتريات للاعتماد", en: "Submitted a purchase invoice", cat: "purchases" },
  PURCHASE_INVOICE_RECEIVED: { ar: "استلم بضاعة فاتورة مشتريات وقدّمها", en: "Received a purchase invoice's goods and submitted it", cat: "purchases" },
  PURCHASE_INVOICE_EDITED_AFTER_RECEIPT: { ar: "عدّل فاتورة مشتريات بعد استلامها", en: "Edited a purchase invoice after receiving", cat: "purchases" },
  PURCHASE_INVOICE_POSTED: { ar: "اعتمد فاتورة مشتريات ورحّلها", en: "Approved and posted a purchase invoice", cat: "purchases" },
  PURCHASE_INVOICE_RETURNED: { ar: "أعاد فاتورة مشتريات للمسودة", en: "Returned a purchase invoice to draft", cat: "purchases" },
  PURCHASE_INVOICE_CANCELLED: { ar: "ألغى فاتورة مشتريات وعكس استلامها", en: "Cancelled a purchase invoice and reversed its receipt", cat: "purchases" },
  PURCHASE_INVOICE_CANCELLED_POSTED: { ar: "ألغى فاتورة مشتريات معتمدة وعكس قيدها", en: "Cancelled an approved purchase invoice and reversed its entry", cat: "purchases" },
  PURCHASE_INVOICE_DELETED: { ar: "حذف مسودة فاتورة مشتريات", en: "Deleted a purchase invoice draft", cat: "purchases" },
  PURCHASE_RECEIPT_REVERSED: { ar: "عكس استلامًا", en: "Reversed a goods receipt", cat: "purchases" },
  PURCHASE_LOT_CREATED: { ar: "أنشأ لوط بن أخضر من فاتورة", en: "Created a green lot from an invoice", cat: "purchases" },
  PURCHASE_LOT_RETIRED: { ar: "أوقف لوطًا بلا رصيد بعد الإلغاء", en: "Deactivated an empty lot after the cancel", cat: "purchases" },
  PURCHASE_ACTION_DENIED: { ar: "رُفض إجراء على فاتورة مشتريات", en: "A purchase invoice action was refused", cat: "purchases" },
};

const SOURCE: Record<string, { ar: string; en: string }> = { WEB: { ar: "ويب", en: "Web" }, STATION: { ar: "محطة", en: "Station" }, SYSTEM: { ar: "النظام", en: "System" } };
const METHOD_AR: Record<string, string> = { PASSWORD: "بكلمة المرور", USERNAME_PIN: "باسم المستخدم والرمز", PIN: "بالرمز" };
const METHOD_EN: Record<string, string> = { PASSWORD: "with password", USERNAME_PIN: "with username and PIN", PIN: "with PIN" };

export type AuditFilters = { q?: string; cat?: AuditCategory; days?: number | null; source?: "all" | "web" | "station" | "system"; before?: string | null; take?: number };

export function parseFilters(sp: URLSearchParams | Record<string, unknown>): AuditFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) : (sp[k] as string | null | undefined)) ?? null;
  const cat = get("cat");
  const days = get("days");
  const source = get("source");
  return {
    q: (get("q") ?? "").trim().slice(0, 80),
    cat: cat === "permissions" || cat === "accounts" || cat === "signin" || cat === "purchases" ? cat : "all",
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
const valueWord = (path: string, v: unknown, lang: "ar" | "en" = "ar") => {
  if (path.endsWith(".access")) return (lang === "en" ? LEVEL_EN : LEVEL_AR)[String(v)] ?? (v === null ? "—" : String(v));
  return v === true ? (lang === "en" ? "Allowed" : "مسموح") : v === false ? (lang === "en" ? "Not allowed" : "غير مسموح") : "—";
};
const roleName = (key: unknown, lang: "ar" | "en" = "ar") => {
  if (typeof key !== "string") return "—";
  const r = SYSTEM_ROLES.find((x) => x.key === key) ?? (key === "custom" ? NO_ACCESS_ROLE : null);
  return r ? (lang === "en" ? r.en : r.ar) : key;
};
const day = (iso: string, lang: "ar" | "en" = "ar") => new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ar-SA-u-nu-latn-ca-gregory", { day: "numeric", month: "long", timeZone: "Asia/Riyadh" }).format(new Date(iso));

export type AuditEntry = {
  id: string; at: string; actor: string; actorId: string | null; action: string; label: string; labelEn: string; cat: string; result: string;
  target: string; targetId: string | null; source: string; details: string; reason: string | null;
  diff: { key: string; label: string; before: string; after: string }[] | null;
};

/** One row in the screen's words. Never reads a credential: the log holds none. */
export type Row = { id: string; userId: string | null; action: string; result: string; reasonCode: string | null; sourceInterface: string; metadata: Prisma.JsonValue; occurredAt: Date };

/**
 * One log row in the viewer's words. `lang` defaults to Arabic (the export and the existing
 * callers); an English viewer gets every phrase — action, target, details, source — in English.
 */
export function describe(r: Row, names: Map<string, string>, lang: "ar" | "en" = "ar"): AuditEntry {
  const T = (ar: string, en: string) => (lang === "en" ? en : ar);
  const m = (r.metadata ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- free-form audit metadata, read field by field
  const def = AUDIT_ACTIONS[r.action] ?? { ar: r.action, en: r.action, cat: "accounts" };
  const actor = r.userId ? names.get(r.userId) ?? "—" : T("النظام", "System");
  let label = T(def.ar, def.en);
  let target = typeof m.targetName === "string" ? m.targetName : m.targetEmployeeId ? names.get(m.targetEmployeeId) ?? "—" : "—";
  let details = "";
  let diff: AuditEntry["diff"] = null;
  const reason = typeof m.reason === "string" ? m.reason : null;
  const methodWord = (k: string) => (lang === "en" ? METHOD_EN : METHOD_AR)[k];
  const cell = (path: string) => cellName(path, lang);
  const value = (path: string, v: unknown) => valueWord(path, v, lang);
  const role = (k: unknown) => roleName(k, lang);
  const sep = T("، ", ", ");
  switch (r.action) {
    case "SIGN_IN": case "MFA_SIGN_IN": {
      target = actor;
      if (r.result === "SUCCESS") details = methodWord(String(m.method ?? r.reasonCode ?? "")) ?? (r.action === "MFA_SIGN_IN" ? T("بالتحقق بخطوتين", "with two-step verification") : "");
      else { label = r.result === "REFUSED" ? T("رُفض الدخول", "Sign-in refused") : T("محاولة دخول فاشلة", "Failed sign-in attempt"); details = r.reasonCode === "TEMP_PASSWORD_EXPIRED" ? T("كلمة مرور مؤقتة منتهية", "Temporary password expired") : methodWord(String(r.reasonCode ?? "")) ?? ""; }
      break;
    }
    case "SIGN_OUT": target = actor; break;
    case "PASSWORD_CHANGED_SELF": target = actor; break;
    case "EMPLOYEE_CREATED":
      details = [T(`الدور: ${role(m.role)}`, `Role: ${role(m.role)}`), m.temporaryPassword ? T("كلمة مرور مؤقتة", "temporary password") : null, m.hrLinked ? T("مرتبط بملف الموظف", "linked to the HR record") : null].filter(Boolean).join(" · ");
      break;
    case "EMPLOYEE_ROLE_CHANGED":
      details = lang === "en" ? `${role(m.oldRole)} → ${role(m.newRole)}` : `${role(m.oldRole)} ← ${role(m.newRole)}`;
      break;
    case "EMPLOYEE_PERMISSIONS_CHANGED": case "PERMISSION_OVERRIDE_EXPIRED": {
      const arrow = T("←", "→");
      const changes = (Array.isArray(m.changes) ? m.changes : []) as { path: string; from: unknown; to: unknown }[];
      const overrides = (Array.isArray(m.overrides) ? m.overrides : []) as { cell: string; effect: string; value: string }[];
      const until = typeof m.expiresAt === "string" ? T(` حتى ${day(m.expiresAt)}`, ` until ${day(m.expiresAt, "en")}`) : "";
      if (r.action === "PERMISSION_OVERRIDE_EXPIRED") {
        const items = (Array.isArray(m.overrides) ? m.overrides : []) as { module: string; sub: string | null; restored: boolean }[];
        details = items.map((o) => T(`«${o.sub ? subLabel(o.module, o.sub) : moduleLabel(o.module)}»${o.restored ? " · عاد إلى قيمة الدور" : ""}`, `“${o.sub ? subLabel(o.module, o.sub, "en") : moduleLabel(o.module, "en")}”${o.restored ? " · back to the role's value" : ""}`)).join(" · ") || T("تلقائيًا عند تاريخ الانتهاء", "automatically at the end date");
      } else if (overrides.length) {
        details = overrides.map((o) => {
          const [mod, sub] = o.cell.split(".");
          const name = sub ? subLabel(mod, sub, lang) : `${moduleLabel(mod, lang)} · ${(lang === "en" ? LEVEL_EN : LEVEL_AR)[o.value] ?? o.value}`;
          return o.effect === "GRANT" ? T(`منح «${name}»${until}`, `granted “${name}”${until}`) : T(`منع «${name}»`, `denied “${name}”`);
        }).join(" · ");
      } else {
        details = changes.slice(0, 3).map((c) => `${cell(c.path)}: ${value(c.path, c.from)} ${arrow} ${value(c.path, c.to)}`).join(" · ") + (changes.length > 3 ? ` · +${changes.length - 3}` : "");
      }
      if (m.via === "ROLE" && typeof m.roleName === "string") details = T(`عبر دور «${m.roleName}» · ${details}`, `through the role “${m.roleName}” · ${details}`);
      diff = changes.map((c) => ({ key: c.path.endsWith(".access") ? c.path : `${c.path.split(".")[0]}.sub.${c.path.split(".")[1]}`, label: cell(c.path), before: value(c.path, c.from), after: value(c.path, c.to) }));
      break;
    }
    case "ROLE_CREATED": case "ROLE_UPDATED": {
      target = T(`دور «${m.roleName ?? "—"}»`, `role “${m.roleName ?? "—"}”`);
      const changes = (Array.isArray(m.changes) ? m.changes : []) as { path: string; from: unknown; to: unknown }[];
      const added = changes.filter((c) => c.to === true || (c.path.endsWith(".access") && c.to !== "none" && c.to !== null));
      const removed = changes.filter((c) => !added.includes(c));
      const q = (s: string) => T(`«${s}»`, `“${s}”`);
      details = r.action === "ROLE_CREATED"
        ? (m.basedOn ? T(`نسخة من ${role(m.basedOn)}`, `a copy of ${role(m.basedOn)}`) : T("دور مخصص جديد", "new custom role"))
        : [added.length ? `${T("أضاف", "added")} ${added.slice(0, 2).map((c) => q(`${cell(c.path)}${c.path.endsWith(".access") ? ` · ${value(c.path, c.to)}` : ""}`)).join(sep)}${added.length > 2 ? T(` و${added.length - 2} أخرى`, ` and ${added.length - 2} more`) : ""}` : null,
           removed.length ? `${T("أزال", "removed")} ${removed.slice(0, 2).map((c) => q(cell(c.path))).join(sep)}${removed.length > 2 ? T(` و${removed.length - 2} أخرى`, ` and ${removed.length - 2} more`) : ""}` : null].filter(Boolean).join(" · ");
      if (Array.isArray(m.members) && m.members.length) details += lang === "en" ? ` · applies to ${m.members.length === 1 ? "one user" : `${m.members.length} users`}` : ` · يسري على ${m.members.length === 1 ? "مستخدم واحد" : m.members.length === 2 ? "مستخدمَين" : `${m.members.length} مستخدمين`}`;
      diff = changes.length ? changes.map((c) => ({ key: c.path, label: cell(c.path), before: value(c.path, c.from), after: value(c.path, c.to) })) : null;
      break;
    }
    case "EMPLOYEE_CREDENTIAL_CHANGED":
      if (m.kind === "TEMPORARY_PASSWORD") { label = T("أعاد تعيين كلمة المرور", "Reset the password"); details = T("كلمة مؤقتة · تُعرض مرة واحدة", "temporary password · shown once"); }
      else if (m.kind === "PIN_CLEARED") { label = T("أعاد تعيين رمز المحطة", "Reset the station PIN"); details = T("يعيّن الموظف رمزًا جديدًا بنفسه", "the employee sets a new PIN themselves"); }
      else details = (Array.isArray(m.credentials) ? m.credentials : []).map((c: string) => (c === "pin" ? T("الرمز", "PIN") : c === "password" ? T("كلمة المرور", "password") : c)).join(" · ");
      break;
    case "ACCOUNT_UNLOCKED": details = T(`${m.attemptsCleared ?? 0} محاولات فاشلة مُسحت`, `${m.attemptsCleared ?? 0} failed attempts cleared`); break;
    case "SESSION_ENDED_ADMIN": case "DEVICE_SESSIONS_ENDED_ADMIN": case "SESSIONS_ENDED_ADMIN": details = T(`${m.sessions ?? 0} جلسات`, `${m.sessions ?? 0} sessions`); break;
    case "AUDIT_EXPORTED": target = T("سجل الصلاحيات", "Permissions log"); details = T(`${m.rows ?? 0} سطرًا`, `${m.rows ?? 0} rows`); break;
    // Workstations W2: the device or station named, never a PIN, code or token.
    case "STATION_SIGN_IN": case "STATION_SIGN_OUT": case "STATION_SWITCH": case "STATION_PIN_FAILED": case "STATION_PIN_LOCKED": case "STATION_PIN_SET":
      target = actor;
      if (r.action === "STATION_SIGN_IN" && r.result !== "SUCCESS") label = r.reasonCode === "NOT_ASSIGNED" ? T("محاولة دخول لمحطة غير مكلّف بها", "Sign-in attempt at a station not assigned") : r.reasonCode === "ADMIN_ROLE" ? T("رُفض دخول المسؤول من محطة", "Administrator sign-in at a station refused") : T("رُفض الدخول من محطة", "Station sign-in refused");
      details = [m.deviceName, r.reasonCode === "IDLE" ? T("خمول", "idle") : r.reasonCode === "LOCK" ? T("قفل", "locked") : null, typeof m.claimsReleased === "number" && m.claimsReleased ? T(`حُرّرت ${m.claimsReleased} مهمة`, `${m.claimsReleased} tasks released`) : null].filter(Boolean).join(" · ");
      break;
    case "STATION_CREATED": case "STATION_UPDATED": case "STATION_POLICY_CHANGED": target = m.stationName ? T(`محطة «${m.stationName}»`, `station “${m.stationName}”`) : T("المحطات", "Stations"); break;
    case "STATION_REGISTERED": case "STATION_CODE_ISSUED": case "STATION_CODE_CANCELLED": case "STATION_ACTIVATED": case "STATION_REVOKED": case "STATION_DEVICE_STATIONS":
      target = m.deviceName ? T(`جهاز «${m.deviceName}»`, `device “${m.deviceName}”`) : T("جهاز محطة", "station device"); details = m.stationName ? T(`المحطة: ${m.stationName}`, `Station: ${m.stationName}`) : ""; break;
    // Unified inventory phase 2: the purchase invoice's activity — the document, its totals, and what changed.
    case "PURCHASE_INVOICE_SAVED": case "PURCHASE_INVOICE_SUBMITTED": case "PURCHASE_INVOICE_RECEIVED": case "PURCHASE_INVOICE_EDITED_AFTER_RECEIPT":
    case "PURCHASE_INVOICE_POSTED": case "PURCHASE_INVOICE_RETURNED": case "PURCHASE_INVOICE_CANCELLED": case "PURCHASE_INVOICE_CANCELLED_POSTED":
    case "PURCHASE_INVOICE_DELETED": case "PURCHASE_RECEIPT_REVERSED": case "PURCHASE_LOT_CREATED": case "PURCHASE_LOT_RETIRED": case "PURCHASE_ACTION_DENIED": {
      target = m.number ? T(`فاتورة ${m.number}`, `invoice ${m.number}`) : T("فاتورة مشتريات", "purchase invoice");
      const a = (m.after ?? null) as { supplierName?: string; grossTotal?: string; lines?: { quantity: string | null; net: string; description: string }[] } | null;
      const b = (m.before ?? null) as { grossTotal?: string; lines?: unknown[] } | null;
      const sar = T("ر.س", "SAR");
      const parts: string[] = [];
      if (r.action === "PURCHASE_ACTION_DENIED") {
        const what: Record<string, [string, string]> = { save: ["الحفظ", "save"], edit: ["تعديل فاتورة مستلمة", "editing a received invoice"], cancel: ["الإلغاء", "cancel"], post: ["الاعتماد والترحيل", "approve and post"] };
        const why: Record<string, [string, string]> = { RECEIVED_CHANGE_REQUIRED: ["بلا صلاحية إلغاء/تعديل فاتورة مستلمة", "without the received-change permission"], SOD_OWN_INVOICE: ["فصل المهام: فاتورته", "segregation of duties: their own invoice"], INVOICE_STALE: ["عدّلها غيره منذ فتحها", "changed by someone else since it was opened"], RECEIVE_REQUIRED: ["بلا صلاحية الاستلام", "without the receive permission"] };
        const w = what[String(m.attempted)] ?? [String(m.attempted ?? "—"), String(m.attempted ?? "—")];
        const y = why[String(m.code)] ?? [String(m.code ?? "—"), String(m.code ?? "—")];
        parts.push(T(`${w[0]} · ${y[0]}`, `${w[1]} · ${y[1]}`));
      } else if (r.action === "PURCHASE_LOT_CREATED" || r.action === "PURCHASE_LOT_RETIRED") parts.push(T(`اللوط ${m.lot?.serialNumber ?? "—"}`, `lot ${m.lot?.serialNumber ?? "—"}`));
      else if (r.action === "PURCHASE_RECEIPT_REVERSED") parts.push(T(`الاستلام ${String(m.purchaseRecordId ?? "").slice(-6)}`, `receipt ${String(m.purchaseRecordId ?? "").slice(-6)}`));
      else {
        if (a?.supplierName) parts.push(a.supplierName);
        if (a?.lines) parts.push(T(`${a.lines.length} سطر`, `${a.lines.length} lines`));
        if (b?.grossTotal && a?.grossTotal && b.grossTotal !== a.grossTotal) parts.push(lang === "en" ? `${b.grossTotal} → ${a.grossTotal} ${sar}` : `${b.grossTotal} ← ${a.grossTotal} ${sar}`);
        else if (a?.grossTotal) parts.push(`${a.grossTotal} ${sar}`);
        if (Array.isArray(m.reversedReceipts) && m.reversedReceipts.length) parts.push(T(`عُكس ${m.reversedReceipts.length} استلام`, `${m.reversedReceipts.length} receipt(s) reversed`));
      }
      details = parts.join(" · ");
      break;
    }
    case "STATION_ACCESS_CHANGED": {
      const ch = (Array.isArray(m.changes) ? m.changes : []) as { stationName: string; to: string }[];
      details = ch.map((c) => `${c.stationName}: ${c.to === "NONE" ? T("غير مسموح", "not allowed") : c.to === "SUPERVISOR" ? T("مسموح · مشرف", "allowed · supervisor") : T("مسموح", "allowed")}`).join(" · ");
      break;
    }
  }
  if (reason && !details.includes(reason) && r.action !== "EMPLOYEE_PERMISSIONS_CHANGED" && r.action !== "ROLE_UPDATED") details = details ? T(`${details} · السبب: ${reason}`, `${details} · reason: ${reason}`) : T(`السبب: ${reason}`, `Reason: ${reason}`);
  return {
    id: r.id, at: r.occurredAt.toISOString(), actor, actorId: r.userId, action: r.action, label, labelEn: def.en, cat: def.cat, result: r.result,
    target, targetId: typeof m.targetEmployeeId === "string" ? m.targetEmployeeId : r.action.startsWith("SIGN") ? r.userId : null,
    source: SOURCE[r.sourceInterface] ? T(SOURCE[r.sourceInterface].ar, SOURCE[r.sourceInterface].en) : r.sourceInterface, details, reason, diff,
  };
}


/** A CSV cell: spreadsheet formulas neutralised (CWE-1236), every cell quoted. */
export const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};
