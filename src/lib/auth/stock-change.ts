// Owner decision 4 (17 Oct), inventory permissions: a PRIVILEGED STOCK CHANGE — a stock count /
// adjustment (`inventory › adjust`: green coffee, packaging material) or an inventory override
// (`inventory › override`: the green-coffee restock of a cancelled roast) — is accepted only, in
// this order, from:
//   1. an account that holds the sub (403 INVENTORY_ADJUST_REQUIRED / INVENTORY_OVERRIDE_REQUIRED);
//   2. a login linked to a VERIFIED person (403 IDENTITY_NOT_VERIFIED, audited);
//   3. for a non-admin holder: a grant with INDEPENDENT approval evidence
//      (src/lib/inventory/privilege-evidence.ts; 403 PRIVILEGE_NOT_APPROVED, audited). The admin role
//      holds the subs by role and skips this step only — never 2, 4, 5 or 6;
//   4. an account with a USERNAME and a real PIN credential (409 USERNAME_PIN_REQUIRED, audited);
//   5. a session SIGNED IN WITH USERNAME + PIN — not a password, not a PIN alone
//      (403 USERNAME_PIN_SESSION_REQUIRED, audited);
//   6. FRESH authentication made WITH THE PIN: a step-up (or the sign-in) within STEP_UP_MS whose
//      secret was the PIN (401 REAUTH_REQUIRED, audited) — the same window and the same answer as
//      every other step-up, because the dashboard's step-up dialog opens on exactly that answer.
//      When the session is fresh but its last strong authentication used the password, the answer
//      is the same 401 with `factor: "PIN"` and a message asking for the PIN.
// The action itself is then audited with who, what, before / after quantities, the reason and the
// authentication freshness (stockAuthSnapshot).
// Pure: no database, no Next.js — shared by the gate (auth-server.ts), the audit and the tests.
import { isBcryptHash } from "./secret";
import { freshEnough, REAUTH_AR, REAUTH_EN, STEP_UP_MS } from "./step-up";
import { normalizeUsername } from "./privileged";

export type StockSub = "adjust" | "override";
export type StockRefusal = { status: 401 | 403 | 409; code: string; error: string; errorEn: string; factor?: "PIN" };

export const STOCK_CHANGE_SUBS: readonly StockSub[] = ["adjust", "override"];

export const STOCK_REFUSALS = {
  ADJUST_REQUIRED: { status: 403, code: "INVENTORY_ADJUST_REQUIRED", error: "عدّ المخزون أو تسويته يحتاج صلاحية «تسوية المخزون» (inventory › adjust).", errorEn: "Counting or adjusting stock needs the inventory adjust permission." },
  OVERRIDE_REQUIRED: { status: 403, code: "INVENTORY_OVERRIDE_REQUIRED", error: "إعادة البن الأخضر إلى المخزون عند إلغاء التحميص تحتاج صلاحية «تجاوز المخزون» (inventory › override).", errorEn: "Restocking green coffee from a cancelled roast needs the inventory override permission." },
  IDENTITY_NOT_VERIFIED: { status: 403, code: "IDENTITY_NOT_VERIFIED", error: "حسابك غير مرتبط بشخص موثّق الهوية؛ تغييرات المخزون المميزة تُنفّذ من حساب فردي موثّق فقط.", errorEn: "Your login is not linked to a verified person: privileged stock changes are made only from a verified individual account." },
  PRIVILEGE_NOT_APPROVED: { status: 403, code: "PRIVILEGE_NOT_APPROVED", error: "هذه الصلاحية لم تُعتمد اعتمادًا مستقلًا من مسؤول حسابات آخر موثّق؛ هي معلّقة حتى يُعاد منحها عبر طلب يعتمده شخص ثانٍ.", errorEn: "This permission was not independently approved by another verified account editor: it is suspended until it is granted again through a second-person request." },
  USERNAME_PIN_REQUIRED: { status: 409, code: "USERNAME_PIN_REQUIRED", error: "تغييرات المخزون المميزة تحتاج حسابًا له اسم مستخدم ورمز PIN؛ اطلب من مسؤول الحسابات إكمالهما.", errorEn: "Privileged stock changes need an account with a username and a PIN. Ask an account editor to set them." },
  USERNAME_PIN_SESSION_REQUIRED: { status: 403, code: "USERNAME_PIN_SESSION_REQUIRED", error: "سجّل الدخول باسم المستخدم ورمز PIN (لا بكلمة المرور ولا بالرمز وحده) لتنفيذ تغييرات المخزون المميزة.", errorEn: "Sign in with your username and PIN (not a password, not the PIN alone) to make privileged stock changes." },
  REAUTH_REQUIRED: { status: 401, code: "REAUTH_REQUIRED", error: REAUTH_AR, errorEn: REAUTH_EN },
  PIN_STEP_UP_REQUIRED: { status: 401, code: "REAUTH_REQUIRED", factor: "PIN", error: "أكّد هويتك من جديد برمز PIN (لا بكلمة المرور) لتنفيذ تغيير المخزون المميز.", errorEn: "Confirm your identity again with your PIN (not your password) to make a privileged stock change." },
} as const satisfies Record<string, StockRefusal>;

/** What the gate knows about the caller (all read live: permissions, session, stored credentials). */
export type StockActorState = {
  holdsSub: boolean;
  verified: boolean;
  /** true for an admin (role), or a non-admin holder with independent approval evidence for the sub. */
  approved: boolean;
  username: string | null | undefined;
  pin: string | null | undefined;
  sessionMethod: string | undefined;
  /** PIN | PASSWORD | null: the secret of the session's last strong authentication (sign-in or step-up). */
  authFactor: string | null | undefined;
  authTime: Date | string | undefined | null;
};

/** The account holds a username (in normal form) and a real PIN credential. */
export const hasUsernameAndPin = (a: { username?: string | null; pin?: string | null }) => !!normalizeUsername(a.username) && isBcryptHash(a.pin);

/** Pure decision, in the gate's order. null = allowed. */
export function stockChangeRefusal(sub: StockSub, s: StockActorState, now = Date.now()): StockRefusal | null {
  if (!s.holdsSub) return sub === "adjust" ? STOCK_REFUSALS.ADJUST_REQUIRED : STOCK_REFUSALS.OVERRIDE_REQUIRED;
  if (!s.verified) return STOCK_REFUSALS.IDENTITY_NOT_VERIFIED;
  if (!s.approved) return STOCK_REFUSALS.PRIVILEGE_NOT_APPROVED;
  if (!hasUsernameAndPin(s)) return STOCK_REFUSALS.USERNAME_PIN_REQUIRED;
  if (s.sessionMethod !== "USERNAME_PIN") return STOCK_REFUSALS.USERNAME_PIN_SESSION_REQUIRED;
  if (!freshEnough(s.authTime, now)) return STOCK_REFUSALS.REAUTH_REQUIRED;
  if (s.authFactor !== "PIN") return STOCK_REFUSALS.PIN_STEP_UP_REQUIRED;
  return null;
}

/** The authentication freshness recorded with every privileged stock change (and every refusal). */
export function stockAuthSnapshot(u: { authTime?: Date | string | null; sessionMethod?: string; sessionMfa?: boolean; sessionId?: string; authFactor?: string | null }, now = Date.now()) {
  const at = u.authTime ? new Date(u.authTime) : null;
  return {
    authTime: at ? at.toISOString() : null,
    authAgeSeconds: at ? Math.max(0, Math.round((now - at.getTime()) / 1000)) : null,
    windowSeconds: STEP_UP_MS / 1000,
    fresh: freshEnough(at, now),
    sessionMethod: u.sessionMethod ?? null,
    authFactor: u.authFactor ?? null,
    mfa: u.sessionMfa ?? null,
    sessionId: u.sessionId ?? null,
  };
}
