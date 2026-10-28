// The controls on recording a SHORTFALL at a transfer's receipt (council F1, on the owner's decision that a receiver
// records it with inventory › transfer_receive alone — no inventory › adjust). Receiving in full is unchanged.
//   (a) a shortfall writes stock off: it is recorded only from a VERIFIED INDIVIDUAL account — never a PIN-only session
//       (a station or shared login; a STATION-scope session never reaches an ERP route at all). 403
//       SHORTFALL_INDIVIDUAL_REQUIRED «تسجيل النقص يحتاج حساب شخصي موثّق». The verified-identity part follows every other
//       identity check: SIMPLE MODE (one trusted operator) does not require it; the PIN-only refusal holds always.
//   (b) segregation of duties: the person who created / sent the transfer (two-step: the creator is the sender) may not
//       write its shortfall off on the receiver's authority — that needs inventory › adjust and the full stock-change gate
//       (identity, approval evidence, username + PIN, a PIN step-up: stockChangeGate). 403 SHORTFALL_SOD_ADJUST_REQUIRED
//       when the sub is missing; the gate's own answer (e.g. 401 REAUTH_REQUIRED, factor PIN) otherwise.
//   (d) at least one person other than the actor is told — receiveTransfer (stock-transfers.ts).
// No value / percentage threshold (the owner has not decided one).
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { parseReceiveLines } from "@/lib/inventory/locations";

export type ShortfallRefusal = { status: 403; code: string; error: string; errorEn: string };

export const SHORTFALL_REFUSALS = {
  INDIVIDUAL_REQUIRED: {
    status: 403, code: "SHORTFALL_INDIVIDUAL_REQUIRED",
    error: "تسجيل النقص يحتاج حساب شخصي موثّق: سجّل الدخول بحسابك الشخصي (لا بالرمز وحده ولا بحساب مشترك)، أو استلم الكمية كاملة واطلب من مشرف تسجيل الفرق.",
    errorEn: "Recording a shortfall needs a verified individual account: sign in with your own account (not a PIN-only or shared login), or receive in full and ask a supervisor to record the difference.",
  },
  SOD_ADJUST_REQUIRED: {
    status: 403, code: "SHORTFALL_SOD_ADJUST_REQUIRED",
    error: "أنت أنشأت هذا التحويل وأرسلته؛ تسجيل نقص فيه يحتاج صلاحية «تسوية المخزون» وتأكيد هويتك (فصل المهام). استلمه كاملًا، أو ليستلمه شخص آخر أو مشرف.",
    errorEn: "You created and sent this transfer: recording a shortfall on it needs «adjust stock» and an identity confirmation (segregation of duties). Receive it in full, or let someone else or a supervisor receive it.",
  },
} as const satisfies Record<string, ShortfallRefusal>;

/** Pure: (a), then (b)'s permission part. null = go on (for (b): to the stock-change gate). */
export function shortfallRefusal(s: { sessionMethod?: string | null; verified: boolean; creatorOrSender: boolean; permissions: Permissions }): ShortfallRefusal | null {
  if (s.sessionMethod === "PIN" || !s.verified) return SHORTFALL_REFUSALS.INDIVIDUAL_REQUIRED;
  if (s.creatorOrSender && !(hasModuleAccess(s.permissions, "inventory") && hasSubPrivilege(s.permissions, "inventory", "adjust"))) return SHORTFALL_REFUSALS.SOD_ADJUST_REQUIRED;
  return null;
}

type GateUser = { id: string; permissions: Permissions; sessionMethod?: string | null };
export type ShortfallDeps = {
  /** The verified-identity check (assertVerifiedActor: SIMPLE MODE passes). */
  verified: (u: GateUser) => Promise<boolean>;
  /** The full stock-change gate for inventory › adjust (stockChangeGate). */
  adjustGate: (u: GateUser) => Promise<NextResponse | null>;
};

/**
 * The gate the receive route runs before receiving: null when the request records no shortfall, or when it may.
 * Reads the transfer (its lines and creator never change after sending); receiveTransfer re-checks the rest.
 */
export async function transferShortfallGate(user: GateUser, transferId: string, body: Record<string, unknown>, deps: ShortfallDeps): Promise<NextResponse | null> {
  const t = await prisma.stockTransfer.findUnique({ where: { id: transferId }, select: { status: true, createdBy: true, lines: { select: { lineNo: true, itemKind: true, qty: true } } } });
  if (!t || t.status !== "IN_TRANSIT") return null;
  const p = parseReceiveLines(body.lines, t.lines);
  if (!p.ok || !p.lines.some((l) => l.qtyShort > 0)) return null;
  const creatorOrSender = t.createdBy === user.id;
  const r = shortfallRefusal({ sessionMethod: user.sessionMethod, verified: user.sessionMethod === "PIN" ? false : await deps.verified(user), creatorOrSender, permissions: user.permissions });
  if (r) return NextResponse.json({ error: r.error, errorEn: r.errorEn, code: r.code }, { status: r.status });
  return creatorOrSender ? deps.adjustGate(user) : null;
}
