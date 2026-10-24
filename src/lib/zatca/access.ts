// ZATCA Phase 2 A4 — who may see and do what (pure; the screens ask the same questions as the routes).
//   view      accounting › zatca_view — the EGS units, the log, the queue, the board tile
//   onboard   accounting › zatca_onboard AND the admin role — EGS units, OTP, CSIDs, renewal, the switch, the
//             numbering cut-over (verified individual + step-up: STEP_UP_KEYS)
//   resubmit  accounting › zatca_resubmit — send a PENDING / ERROR document again
//   xml       accounting › zatca_xml — download the signed / cleared XML (and only for invoices in the viewer's scope)
// The per-invoice e-invoicing panel (status, ICV, hash) is part of the invoice: whoever sees the invoice sees it.
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

type P = Permissions | Record<string, unknown>;
const sub = (p: P, s: string) => hasModuleAccess(p as Permissions, "accounting") && hasSubPrivilege(p as Permissions, "accounting", s);

export const canZatcaView = (p: P) => sub(p, "zatca_view");
export const canZatcaOnboard = (p: P, role?: string | null) => sub(p, "zatca_onboard") && role === "admin";
export const canZatcaResubmit = (p: P) => sub(p, "zatca_resubmit");
export const canZatcaXml = (p: P) => sub(p, "zatca_xml");

export function zatcaAbilities(p: P, role?: string | null) {
  return { view: canZatcaView(p), onboard: canZatcaOnboard(p, role), resubmit: canZatcaResubmit(p), xml: canZatcaXml(p) };
}
