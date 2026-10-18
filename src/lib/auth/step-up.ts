// Fresh authentication for sensitive actions (owner security decision, 16 Oct). Pure: no
// database, no Next.js — importable by the HR services and the tests.
//
// The session's authTime is the last strong authentication (sign-in, or step-up through
// POST /api/auth/reauth). Payroll approval, payment recording and post-approval cancellation,
// and every decision on a permission / credential change, an identity request or an MFA reset,
// need it within STEP_UP_MS; otherwise 401 REAUTH_REQUIRED and the page asks again for the PIN
// or password (and the verification code when MFA is enrolled).
export const STEP_UP_MS = 10 * 60 * 1000;
export const REAUTH_AR = "هذا الإجراء يحتاج تأكيد هويتك من جديد: أدخل رمزك أو كلمة المرور (ورمز التحقق إن كان مفعّلًا).";
export const REAUTH_EN = "This action needs you to confirm your identity again: enter your PIN or password (and your verification code if enabled).";
export const freshEnough = (authTime: Date | string | undefined | null, now = Date.now()) => !!authTime && now - new Date(authTime).getTime() <= STEP_UP_MS;
