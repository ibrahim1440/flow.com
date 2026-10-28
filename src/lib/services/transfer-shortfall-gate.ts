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
//   (e) the owner's THRESHOLD (feat/shortfall-threshold; src/lib/inventory/shortfall-threshold.ts): a line short by more
//       than the percent, worth more than the value (or of unknown value), received at zero; a transfer whose lines sum
//       over the value; a receiver whose 30 days pass N × the value — needs inventory › adjust
//       and the stock-change gate whoever receives — 403 SHORTFALL_THRESHOLD_ADJUST_REQUIRED naming the limits when the
//       sub is missing. receiveTransfer re-judges it on the locked holders and refuses unless this gate cleared it.
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { parseReceiveLines } from "@/lib/inventory/locations";
import { breachWords, judgementWords, thresholdRefusal, type Breach, type TransferBreach } from "@/lib/inventory/shortfall-threshold";
import { judgeReceipt } from "@/lib/services/stock-transfers";

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

const holdsAdjust = (p: Permissions) => hasModuleAccess(p, "inventory") && hasSubPrivilege(p, "inventory", "adjust");
/** Who may read costs (the valuation page's rule): accounting, or inventory › valuation. */
export const canReadCost = (p: Permissions) => hasModuleAccess(p, "accounting") || hasSubPrivilege(p, "inventory", "valuation");

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
 * The gate the receive route runs before receiving. `refused`: the answer to send (null = go on). `thresholdCleared`:
 * the request is over the threshold and passed inventory › adjust + the stock-change gate (receiveTransfer needs it).
 * Reads the transfer (its lines and creator never change after sending); receiveTransfer re-checks the rest.
 */
export async function evaluateShortfall(user: GateUser, transferId: string, body: Record<string, unknown>, deps: ShortfallDeps): Promise<{ refused: NextResponse | null; thresholdCleared: boolean }> {
  const t = await prisma.stockTransfer.findUnique({ where: { id: transferId }, select: { status: true, createdBy: true, lines: { select: { lineNo: true, itemKind: true, entityId: true, qty: true } } } });
  if (!t || t.status !== "IN_TRANSIT") return { refused: null, thresholdCleared: false };
  const p = parseReceiveLines(body.lines, t.lines);
  if (!p.ok || !p.lines.some((l) => l.qtyShort > 0)) return { refused: null, thresholdCleared: false };
  const creatorOrSender = t.createdBy === user.id;
  const r = shortfallRefusal({ sessionMethod: user.sessionMethod, verified: user.sessionMethod === "PIN" ? false : await deps.verified(user), creatorOrSender, permissions: user.permissions });
  if (r) return { refused: NextResponse.json({ error: r.error, errorEn: r.errorEn, code: r.code }, { status: r.status }), thresholdCleared: false };
  // The owner's threshold, mirrored from receiveTransfer (which judges it again under the transfer lock): per line, per
  // transfer, per receiver over 30 days. Amounts only for cost readers (council F5).
  const { limits, judgement: j } = await judgeReceipt(prisma, { id: transferId, lines: t.lines }, p.lines, user.id);
  const costs = canReadCost(user.permissions);
  if (j.over && !holdsAdjust(user.permissions)) {
    const x = thresholdRefusal(j, limits, costs);
    return { refused: NextResponse.json({ error: x.error, errorEn: x.errorEn, code: x.code, limits: x.limits, lines: j.lines.map((l) => ({ lineNo: l.lineNo, breaches: l.breaches, ...(costs ? { valueSar: l.valueSar } : {}) })) }, { status: x.status }), thresholdCleared: false };
  }
  if (creatorOrSender || j.over) {
    const g = await deps.adjustGate(user);
    return { refused: g, thresholdCleared: !g && j.over };
  }
  return { refused: null, thresholdCleared: false };
}

/** The same gate, the answer only. */
export async function transferShortfallGate(user: GateUser, transferId: string, body: Record<string, unknown>, deps: ShortfallDeps): Promise<NextResponse | null> {
  return (await evaluateShortfall(user, transferId, body, deps)).refused;
}

export type ShortfallPreview = {
  /** Per short line: over the limit or not, which limits, and — cost readers only — the value judged. */
  lines: { lineNo: number; over: boolean; limits: Breach[]; wordsAr: string; wordsEn: string; valueSar?: number | null }[];
  /** Transfer-level limits exceeded (TRANSFER_VALUE, ROLLING), and in words. */
  transfer: TransferBreach[];
  transferWordsAr?: string; transferWordsEn?: string;
  over: boolean;
  /** Recording it needs inventory › adjust and the stock-change gate (over the limit, or the receiver sent it). */
  needsAdjust: boolean;
  canAdjust: boolean;
  /** The receiver cannot record a shortfall at all from this session (PIN-only / not a verified individual). */
  individualRequired: boolean;
  /** The limits exceeded in words, for this viewer (amounts for cost readers only). */
  wordsAr: string; wordsEn: string;
};

/**
 * The receive dialog's preview (council F5): a VERDICT per line — never the cost holder's qty or value. Same judgement
 * as the gate and the receipt; the receipt still decides.
 */
export async function previewShortfall(user: GateUser, transferId: string, body: Record<string, unknown>, deps: Pick<ShortfallDeps, "verified">): Promise<ShortfallPreview | null> {
  const t = await prisma.stockTransfer.findUnique({ where: { id: transferId }, select: { status: true, createdBy: true, lines: { select: { lineNo: true, itemKind: true, entityId: true, qty: true } } } });
  if (!t || t.status !== "IN_TRANSIT") return null;
  // The reason is not judged here (the dialog asks for it): a placeholder lets the quantities parse.
  const lines = Array.isArray(body.lines) ? (body.lines as Record<string, unknown>[]).map((l) => ({ ...l, varianceReason: "preview" })) : body.lines;
  const p = parseReceiveLines(lines, t.lines);
  const canAdjust = holdsAdjust(user.permissions);
  const empty: ShortfallPreview = { lines: [], transfer: [], over: false, needsAdjust: false, canAdjust, individualRequired: false, wordsAr: "", wordsEn: "" };
  if (!p.ok || !p.lines.some((l) => l.qtyShort > 0)) return empty;
  const costs = canReadCost(user.permissions);
  const { limits, checks, judgement: j } = await judgeReceipt(prisma, { id: transferId, lines: t.lines }, p.lines, user.id);
  const verified = user.sessionMethod === "PIN" ? false : await deps.verified(user);
  const [wordsAr, wordsEn] = j.over ? judgementWords(j, limits, costs) : ["", ""];
  return {
    lines: checks.map((c) => {
      const o = j.lines.find((l) => l.lineNo === c.lineNo);
      const w = (o?.breaches ?? []).map((b) => breachWords(b, limits, c, j, costs));
      return { lineNo: c.lineNo, over: !!o, limits: o?.breaches ?? [], wordsAr: w.map((x) => x[0]).join("، "), wordsEn: w.map((x) => x[1]).join(", "), ...(costs ? { valueSar: c.valueSar } : {}) };
    }),
    transferWordsAr: j.transfer.map((b) => breachWords(b, limits, null, j, costs)[0]).join("؛ "), transferWordsEn: j.transfer.map((b) => breachWords(b, limits, null, j, costs)[1]).join("; "),
    transfer: j.transfer, over: j.over, needsAdjust: j.over || t.createdBy === user.id, canAdjust,
    individualRequired: user.sessionMethod === "PIN" || !verified, wordsAr, wordsEn,
  };
}
