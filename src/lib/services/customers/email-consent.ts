// The database half of «يستقبل إيميلات» (fix round 1, council b25): one function both the customer form and the
// «الرسائل» card go through, so neither can switch e-mails back on for a customer who stopped them themselves.
import type { Prisma } from "@/generated/prisma/client";
import type { Permissions } from "@/lib/auth-shared";
import { canEdit } from "@/lib/auth-shared";
import { customersScopedToOwner } from "@/lib/services/sales/scope";
import { hasModuleAccess } from "@/lib/auth-shared";
import { appendOptOutNote, optInRule, SOURCE_TEXT_AR } from "@/lib/automation/email-consent";

type Viewer = { id: string; name?: string | null; role?: string | null; permissions: Permissions | Record<string, unknown> };

/** A manager (customers at edit, not limited to an own book) or the administrator. */
export function isCustomerManager(user: Viewer): boolean {
  if (user.role === "admin") return true;
  return canEdit(user.permissions as Permissions, "customers") && !customersScopedToOwner(user);
}

/**
 * Owner rep · manager · admin (owner decision, 31 Oct 2026): the administrator; whoever edits customers (a rep scoped
 * to their own book: only their own customer); and the customer's account owner with the sales module, even when the
 * customers module is view-only for them — the rep is who knows the customer's e-mail.
 */
export function canEditMessaging(user: Viewer, accountOwnerId: string | null): boolean {
  if (user.role === "admin") return true;
  const perms = user.permissions as Permissions;
  if (accountOwnerId && accountOwnerId === user.id && hasModuleAccess(perms, "sales")) return true;
  if (!canEdit(perms, "customers")) return false;
  return !customersScopedToOwner(user);
}

export type ConsentChange = { data: Prisma.CustomerUncheckedUpdateInput; before: Record<string, unknown>; after: Record<string, unknown> };

/**
 * The update for one change of «يستقبل إيميلات», or a refusal thrown as an app error. Turning e-mails back on for a
 * customer who stopped them (unsubscribe link, complaint, bounce, or a suppressed address) needs a manager or the
 * administrator AND a reason; the history line saying the customer stopped them is never overwritten — one line is
 * appended for every change.
 */
export async function emailConsentChange(tx: Prisma.TransactionClient, o: {
  customerId: string; turningOn: boolean; actor: Viewer; reason?: string | null; at?: Date;
}): Promise<ConsentChange | null> {
  const c = await tx.customer.findUnique({ where: { id: o.customerId }, select: { email: true, emailOptOut: true, emailOptOutSource: true, emailOptOutNote: true } });
  if (!c) throw { _appCode: 404, message: "Not found" };
  if (o.turningOn === !c.emailOptOut) return null;
  const at = o.at ?? new Date();
  const email = c.email?.trim().toLowerCase() ?? null;
  const suppressed = !!email && !!(await tx.emailSuppression.findUnique({ where: { email }, select: { email: true } }));
  const rule = optInRule({ turningOn: o.turningOn, source: c.emailOptOutSource, suppressed, isManager: isCustomerManager(o.actor), reason: o.reason });
  if (!rule.ok) throw { _appCode: rule.status, message: rule.error, errorEn: rule.errorEn, code: rule.code };
  const who = o.actor.name ?? "موظف";
  const line = o.turningOn
    ? `أرجعها ${who}${o.reason?.trim() ? `: ${o.reason.trim()}` : ""}${c.emailOptOutSource && SOURCE_TEXT_AR[c.emailOptOutSource] ? ` (كانت: ${SOURCE_TEXT_AR[c.emailOptOutSource]})` : ""}`
    : `أوقفها ${who}${o.reason?.trim() ? `: ${o.reason.trim()}` : ""}`;
  const note = appendOptOutNote(c.emailOptOutNote, at, line);
  return {
    data: o.turningOn
      ? { emailOptOut: false, emailOptOutAt: null, emailOptOutSource: null, emailOptOutNote: note }
      : { emailOptOut: true, emailOptOutAt: at, emailOptOutSource: "staff", emailOptOutNote: note },
    before: { emailOptOut: c.emailOptOut, emailOptOutSource: c.emailOptOutSource, suppressed },
    after: { emailOptOut: !o.turningOn, reason: o.reason?.trim() || null },
  };
}
