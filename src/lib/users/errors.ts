import { NextResponse } from "next/server";

/**
 * A refusal of the users, roles & permissions area: a stable code and the Arabic and English text
 * the screens show (Figma UR-15 states). Thrown inside a transaction so nothing is written.
 */
export class UsersError extends Error {
  constructor(readonly status: number, readonly code: string, readonly ar: string, readonly en: string, readonly extra: Record<string, unknown> = {}) {
    super(en);
    this.name = "UsersError";
  }
  response() {
    return NextResponse.json({ error: this.ar, errorEn: this.en, code: this.code, ...this.extra }, { status: this.status });
  }
}

/** UR-S08 — no self-elevation (P-4): nobody changes their own role, permissions or access. */
export const SELF_ACCESS = () => new UsersError(403, "SELF_ACCESS_CHANGE", "رفض الخادم الحفظ. لا يستطيع المستخدم منح نفسه صلاحية أو تغيير دوره أو إيقاف حسابه. لم يُحفظ شيء.", "Refused: nobody may change their own role, permissions or access. Nothing was saved.");

/** UR-S09 — the last active administrator stays an active administrator. */
export const LAST_ADMIN = (name: string) => new UsersError(409, "LAST_ADMIN", `لا يمكن إيقاف ${name} أو تغيير دوره. هو آخر حساب نشط يملك إدارة المستخدمين. امنحها لحساب آخر أولًا.`, `${name} is the last active account that manages users. Give that to another account first.`);

/** Only the administrator role edits roles, exceptions and credentials (owner rule). */
export const ADMIN_ONLY_AR = "إدارة الأدوار والصلاحيات وبيانات الدخول لمدير المنشأة فقط.";

/**
 * Owner decision 19 Oct: another account's role, permissions or custom role are changed by the
 * administrator or a power user (employees › manage_access) — employees › edit alone does not.
 */
export const ACCESS_MANAGER_ONLY = () => new UsersError(403, "ACCESS_MANAGER_ONLY", "تغيير أدوار المستخدمين وصلاحياتهم لمدير المنشأة أو لمستخدم متقدّم يختاره. لم يُحفظ شيء.", "Only the administrator or a power user they chose changes users' roles and permissions. Nothing was saved.");

/** A power user without employees › edit changes access only, not the account's other fields. */
export const OTHER_FIELDS_NEED_EDIT = () => new UsersError(403, "EMPLOYEE_EDIT_REQUIRED", "تستطيع تغيير الصلاحيات فقط. تعديل بيانات الحساب الأخرى يتطلب صلاحية «تعديل صلاحيات المستخدمين». لم يُحفظ شيء.", "You may change permissions only; the account's other fields need employees › edit. Nothing was saved.");
