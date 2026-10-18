/**
 * The audit of a privileged inventory action (owner decision 16 Oct, inventory privileges
 * Option A): a stock adjustment (`inventory › adjust`) or an inventory override
 * (`inventory › override`, the restock of a cancelled roast).
 *
 * The movement itself (InventoryMovement) already records the login and the reason. This row adds
 * what the owner asked for on top: the RESPONSIBLE PERSON, not only the login — the verified HR
 * or external person record the login belongs to, and the verification that attests it. The gate
 * (requirePrivilegedAction) has already refused anyone who is not a verified individual, so the
 * person is always present here. Written in the caller's transaction: the action and its audit
 * commit or roll back together. HrAuditLog is append-only.
 *
 * Owner decision 4 (17 Oct): the row records WHO (login + verified person), WHAT (the action and
 * the entity), the quantities BEFORE and AFTER (`before.quantity` / `after.quantity`, in the
 * entity's unit), the REASON and the AUTHENTICATION FRESHNESS (`after.auth`: last strong
 * authentication, its age, the step-up window, the sign-in method, MFA). The gate
 * (stockChangeGate) has already required a username + PIN credential and a fresh step-up.
 */
import { audit, type Db } from "@/lib/hr/core";
import { identityOf } from "@/lib/hr/identity";
import { stockAuthSnapshot } from "@/lib/auth/stock-change";

export type PrivilegedInventoryAction = "INVENTORY_ADJUSTED" | "INVENTORY_OVERRIDE_RESTOCK";

export async function auditPrivilegedInventory(
  tx: Db,
  user: { id: string; name?: string | null; sessionId?: string; authTime?: Date | string; sessionMethod?: string; sessionMfa?: boolean },
  e: { action: PrivilegedInventoryAction; entityType: string; entityId: string; reason: string; beforeQuantity: number; afterQuantity: number; unit: string; details: Record<string, unknown> },
) {
  const who = await identityOf(tx, user.id);
  await audit(tx, {
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    reason: e.reason,
    actorId: user.id,
    before: { quantity: e.beforeQuantity, unit: e.unit },
    after: {
      ...e.details,
      quantity: e.afterQuantity,
      unit: e.unit,
      sub: e.action === "INVENTORY_ADJUSTED" ? "inventory.adjust" : "inventory.override",
      auth: stockAuthSnapshot(user),
      login: { id: user.id, name: user.name ?? null, sessionId: user.sessionId ?? null },
      person: who.person ? { type: who.person.type, id: who.person.id, name: who.person.name } : null,
      verificationId: who.verification?.id ?? null,
      verified: who.verified,
    },
  });
}
