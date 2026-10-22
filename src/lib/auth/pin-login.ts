/**
 * W0 (security): PIN sign-in is OFF unless the server explicitly turns it on.
 *
 * The login page has shown only username + password since SIMPLE MODE, but POST /api/auth/login
 * still accepted `method: "pin"` — and fell back to it when `method` was omitted — so a 4-6 digit
 * PIN alone still opened a full ERP session. The PIN code paths stay in place (stations or the
 * mobile app may need them later); they are reachable only when the deployment sets
 *
 *   AUTH_PIN_LOGIN_ENABLED=1        (also "true", "on", "yes"; anything else, or unset, is off)
 *
 * Scope: the two PIN SIGN-IN methods ("pin", "username_pin") and finishing an MFA challenge that
 * one of them started. Not affected: step-up re-authentication of an already signed-in user
 * (POST /api/auth/reauth proves the user's own PIN or password), guest QC links (their own
 * signed token), setting / changing a PIN, and password sign-in with or without MFA.
 */
export function pinLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.AUTH_PIN_LOGIN_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Kept for the code path's restoration and for the tests. Not sent any more: since Workstations W0
 * (owner decision D4) a refused PIN sign-in answers the generic 401 «بيانات الدخول غير صحيحة»
 * (sign-in.ts INVALID), so nothing tells a caller that PIN sign-in exists or is switched off.
 */
export const PIN_LOGIN_DISABLED = {
  error: "Sign-in with a PIN is turned off. Sign in with your username and password.",
  errorAr: "تسجيل الدخول بالرمز السري متوقف. سجّل الدخول باسم المستخدم وكلمة المرور.",
  code: "PIN_LOGIN_DISABLED",
} as const;

/** The session methods a PIN sign-in produces. */
export const PIN_SESSION_METHODS: readonly string[] = ["PIN", "USERNAME_PIN"];
