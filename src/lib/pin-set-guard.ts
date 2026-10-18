// Review item 1 (orchestrator, 16 Oct): setting a PIN must not confirm another account's PIN.
//
// PIN-only sign-in needs PINs to be unique, so a PIN another account holds has to be refused.
// What the refusal must not do is confirm it. Every path that sets a PIN — account creation,
// account edit and self-service — therefore:
//   · is throttled per platform-reported address, per acting account (from any address) and by
//     the system-wide PIN bucket, before anything is checked;
//   · refuses with ONE generic message («تعذّر استخدام هذا الرمز، اختر رمزًا آخر») that does not
//     say why;
//   · counts the refusal toward the throttle and audits it (route and outcome only, never the PIN);
//   · derives the bcrypt verifier BEFORE the uniqueness lookup, so a taken and a free PIN cost
//     the same time (the lookup itself is one indexed equality on the keyed selector).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractIp, hashRateLimitKey, isIdentifierRateLimited, isIpRateLimited, isPinSpaceConstrained, pruneExpired, recordPinFailure } from "@/lib/rate-limit";

export const PIN_UNAVAILABLE_AR = "تعذّر استخدام هذا الرمز، اختر رمزًا آخر.";
export const PIN_UNAVAILABLE_EN = "This PIN cannot be used. Choose another one.";
export type PinSetRoute = "EMPLOYEE_CREATE" | "EMPLOYEE_EDIT" | "PROFILE";

const keys = (request: Request, actorId: string) => ({ ipHash: hashRateLimitKey(extractIp(request)), idHash: hashRateLimitKey(`pin-set:${actorId}`) });

/** 429 when this address or this acting account has had too many refused PIN choices recently. */
export async function pinSetThrottle(request: Request, actorId: string): Promise<NextResponse | null> {
  const { ipHash, idHash } = keys(request, actorId);
  await pruneExpired();
  // Review P2-6: the address comes from the platform only (extractIp); the per-actor limit counts
  // that actor's refusals from every address; and while the system-wide PIN bucket is under a
  // burst, PIN-setting waits too.
  if ((await isIpRateLimited(ipHash, 30)) || (await isIdentifierRateLimited(idHash, 10)) || (await isPinSpaceConstrained())) {
    return NextResponse.json({ error: "محاولات كثيرة. حاول لاحقًا.", errorEn: "Too many requests. Try again later.", code: "RATE_LIMITED" }, { status: 429 });
  }
  return null;
}

/** The single refusal for a PIN that cannot be used: counted, audited without the PIN, generic. */
export async function pinUnavailable(request: Request, actorId: string, targetId: string | null, route: PinSetRoute): Promise<NextResponse> {
  const { ipHash, idHash } = keys(request, actorId);
  // Counted per actor AND in the system-wide PIN bucket that PIN sign-in reads.
  await recordPinFailure(ipHash, idHash).catch(() => undefined);
  await prisma.hrAuditLog.create({ data: { action: "PIN_SET_REFUSED", entityType: "Employee", entityId: targetId ?? actorId, after: { route, reason: "UNAVAILABLE" }, actorId } }).catch(() => undefined);
  return NextResponse.json({ error: PIN_UNAVAILABLE_AR, errorEn: PIN_UNAVAILABLE_EN, code: "PIN_UNAVAILABLE" }, { status: 409 });
}

/** A PIN-uniqueness race lost at the database (UNIQUE pinLookup) gets the same answer. */
export function isPinLookupConflict(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  return e?.code === "P2002" && JSON.stringify(e.meta?.target ?? "").includes("pinLookup");
}
