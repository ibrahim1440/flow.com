// The pure rules of «جاهزية البن الأخضر» (lib/services/green-readiness.ts): who the alert is for, and its state —
// client-safe and testable without a database.
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

/**
 * Who the alert is for — exactly the notification's recipients (catalog «production.green_transfer_needed»): the stock
 * movers (inventory › receive / adjust) and the schedule managers, by the request's effective permissions.
 */
export function canReceiveGreenAlert(user: { permissions: Permissions }): boolean {
  return hasSubPrivilege(user.permissions, "inventory", "receive") || hasSubPrivilege(user.permissions, "inventory", "adjust")
    || hasSubPrivilege(user.permissions, "production", "manage_schedule");
}

/** The alert's state: lot · source site · shortfall bucket (ceil to 5 kg) | the exact shortfall (council F3). */
export function alertState(g: { lotId: string; fromId: string | null; shortKg: number }): string {
  return `${g.lotId}:${g.fromId ?? ""}:${Math.ceil(g.shortKg / 5) * 5}|${g.shortKg}`;
}
/** Unread again only when the lot or the site changed, or the shortfall grew into a higher bucket. */
export function alertIsNews(prev: string | null | undefined, next: string): boolean {
  if (!prev || prev === "OK") return true;
  const [pk] = prev.split("|"), [nk] = next.split("|");
  const [pl, pf, pb] = pk.split(":"), [nl, nf, nb] = nk.split(":");
  return pl !== nl || pf !== nf || Number(nb) > Number(pb);
}

