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
import { requireSub, stockChangeGate } from "@/lib/auth-server";
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

export type PurchaseCan = { draft: boolean; ap: boolean; receive: boolean; inventory: boolean; read: boolean; suppliers: boolean; changeReceived: boolean; adjust: boolean };
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
    // «نقص من المورد»: a shortfall written off as a loss, or a claim abandoned — inventory › adjust (+ step-up, the route).
    adjust: hasSubPrivilege(permissions, "inventory", "adjust"),
  };
}

/**
 * «نقص من المورد» (20261119090000_supplier_shortfall): a save that writes a supplier shortfall off as a LOSS («خسارة»)
 * is a stock write-off — inventory › adjust through the stock-change gate (verified individual, step-up), the gate of
 * a stock adjustment. Only asked when the body has such a line; the service refuses the line without the grant.
 */
export async function shortfallLossGate(user: Parameters<typeof stockChangeGate>[0], body: Record<string, unknown>): Promise<{ error: Response | null; mayWriteOffShortfall: boolean }> {
  const lines = Array.isArray(body.lines) ? (body.lines as Record<string, unknown>[]) : [];
  const wants = lines.some((l) => l && l.shortfallTreatment === "LOSS" && l.billedQty !== undefined && l.billedQty !== null && l.billedQty !== "");
  if (!wants) return { error: null, mayWriteOffShortfall: false };
  const refused = await stockChangeGate(user, "inventory", "adjust");
  return refused ? { error: refused, mayWriteOffShortfall: false } : { error: null, mayWriteOffShortfall: true };
}
