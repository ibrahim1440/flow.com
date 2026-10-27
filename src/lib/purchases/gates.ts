// Phase 2 — who may do what on the one purchases screen. Every gate is an EXISTING one; nothing is widened:
//   • read the invoices (list, detail, CSV)         the AP read gate: accounting module or purchases › invoices;
//   • save (draft, submit, receive, edit, cancel)   the AP draft writer: purchases › invoices (operational) or
//                                                    accounting › ap (privileged: a verified individual);
//   • … and when the save RECEIVES stock lines,      inventory › receive as well — the receiving duty of
//     creates a new green lot, or REVERSES a          POST /api/purchases, /api/materials/:id/receive and
//     receipt (edit / cancel of a received invoice)   POST /api/green-beans (enforced in the service: `mayReceive`);
//   • … and to REVERSE a receipt (cancel / edit a    purchases › received_change («إلغاء/تعديل فاتورة مستلمة»),
//     received, un-posted invoice)                    granted by the phase-2 migration to whoever could already
//                                                    (enforced in the service: `mayChangeReceived`);
//   • approve = post in the same save               accounting › ap through requireSub (verified individual +
//                                                    step-up), the gate of POST …/invoices/:id/post; the SoD
//                                                    setting decides in the service whether the preparer may post.
import { requireSub } from "@/lib/auth-server";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { requireDraftWriter } from "@/lib/accounting/ops/http";

type Gate = Awaited<ReturnType<typeof requireDraftWriter>> & { mayReceive: boolean; mayChangeReceived: boolean };

/** The gate of a save with this action. */
export async function purchaseSaveGate(action: string): Promise<Gate> {
  const g = await requireDraftWriter();
  if (g.error) return { ...g, mayReceive: false, mayChangeReceived: false };
  if (action === "post") {
    const ap = await requireSub("accounting", "ap");
    if (ap.error) return { user: g.user, error: ap.error, mayReceive: false, mayChangeReceived: false };
  }
  return {
    ...g,
    mayReceive: hasSubPrivilege(g.user.permissions, "inventory", "receive"),
    // Phase 2: reversing a receipt (cancel / edit a received, un-posted invoice) is its own grant.
    mayChangeReceived: hasSubPrivilege(g.user.permissions, "purchases", "received_change"),
  };
}

export type PurchaseCan = { draft: boolean; ap: boolean; receive: boolean; inventory: boolean; read: boolean; suppliers: boolean; changeReceived: boolean };
export function purchaseCan(permissions: Parameters<typeof hasSubPrivilege>[0]): PurchaseCan {
  return {
    draft: hasSubPrivilege(permissions, "purchases", "invoices") || hasSubPrivilege(permissions, "accounting", "ap"),
    ap: hasSubPrivilege(permissions, "accounting", "ap"),
    receive: hasSubPrivilege(permissions, "inventory", "receive"),
    inventory: hasModuleAccess(permissions, "inventory"),
    read: hasModuleAccess(permissions, "accounting") || hasSubPrivilege(permissions, "purchases", "invoices"),
    // POST /api/suppliers and the name / contact edit: inventory › receive or adjust.
    suppliers: hasSubPrivilege(permissions, "inventory", "receive") || hasSubPrivilege(permissions, "inventory", "adjust"),
    changeReceived: hasSubPrivilege(permissions, "purchases", "received_change"),
  };
}
