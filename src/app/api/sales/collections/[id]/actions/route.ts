import { NextResponse } from "@/lib/api-response";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireAnyModule, privilegedGate } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import {
  approveCollection, rejectCollection, reverseCollection, collectionSummary, type ConfirmFields,
} from "@/lib/services/sales/collections";
import { decisionKey } from "@/lib/services/sales/receipts";
import { settleExpiredOverrides } from "@/lib/users/overrides";
import { auditFromRequest, setAuditContext } from "@/lib/accounting/audit";
import type { ReceiptAllocation } from "@/lib/services/invoicing/ar";
import { serialiseSummary } from "../../route";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/sales/collections/[id]/actions — the finance decision.
 *
 * ── Why one endpoint ──
 * Approve, reject and reverse are three answers to the same question and share every
 * precondition: the row is locked, the caller is not the submitter, and the current status
 * decides what is still possible. Three endpoints would be three copies of that, and the
 * copies would drift.
 *
 * ── Who decides (BATCH22 WP-D «سند قبض») ──
 * The accountant confirms with `accounting › receipts_confirm` (step-up) — and may then choose the deposit account, the
 * memo and the allocation; Finance's older `commissions › collection_verify / _reject` keep working (with the defaults).
 * «إعادة للتصحيح» (`return`) is a reasoned rejection the rep can copy and correct. Reverse stays
 * `commissions › collection_reverse` (an accountant's own receipt: `receipts_confirm`) and, once accounting is active,
 * ALSO needs `accounting › journal_reverse` through the central gate (step-up): it reverses a posted receipt.
 * An accountant's receipt (no deal, no commission) is decided with the accounting key only.
 */
const ACTIONS = ["approve", "reject", "return", "reverse"] as const;
type Action = (typeof ACTIONS)[number];

function parseAllocation(v: unknown): ReceiptAllocation | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (v === "AUTO") return "AUTO";
  if (!Array.isArray(v)) return null;
  const out: { invoiceId: string; amount: string }[] = [];
  for (const x of v) {
    const r = (x ?? {}) as Record<string, unknown>;
    const amount = typeof r.amount === "string" || typeof r.amount === "number" ? String(r.amount).trim() : "";
    if (typeof r.invoiceId !== "string" || !/^\d+(\.\d{1,2})?$/.test(amount)) return null;
    out.push({ invoiceId: r.invoiceId, amount });
  }
  return out;
}

export async function POST(request: Request, { params }: Params) {
  // Module access only at the door; the ability is checked against the action below, so a
  // caller who holds one of the keys does not get the others for free.
  const { user, error } = await requireAnyModule("commissions", "accounting");
  if (error) return error;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const action = typeof b.action === "string" && (ACTIONS as readonly string[]).includes(b.action)
    ? (b.action as Action)
    : null;
  if (!action) {
    return NextResponse.json({ error: "action must be one of: " + ACTIONS.join(", ") }, { status: 400 });
  }

  const row = await prisma.salesCollection.findUnique({ where: { id }, select: { source: true, opportunityId: true, submittedById: true } });
  if (!row) return NextResponse.json({ error: "Collection not found." }, { status: 404 });

  const key = decisionKey(user.permissions, action, row.source);
  if (!key) {
    return NextResponse.json(
      { error: "لا تملك صلاحية هذا القرار على السند.", errorEn: "You do not hold the permission for this decision on this collection.", code: "NO_PRIVILEGE" },
      { status: 403 },
    );
  }
  // A privileged permission: exercised by a verified individual only (SOD.md §19); receipts_confirm also steps up.
  const refused = await privilegedGate(user, key[0], key[1]);
  if (refused) return refused;

  if (action === "reverse") {
    const s = await prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true } });
    if (s?.accountingActive) {
      if (!(hasModuleAccess(user.permissions, "accounting") && hasSubPrivilege(user.permissions, "accounting", "journal_reverse"))) {
        return NextResponse.json(
          { error: "عكس سند قبض مرحّل يحتاج أيضًا صلاحية «عكس القيود المرحّلة».", errorEn: "Reversing a posted receipt also needs accounting › journal_reverse.", code: "JOURNAL_REVERSE_REQUIRED" },
          { status: 403 },
        );
      }
      const gate = await privilegedGate(user, "accounting", "journal_reverse");
      if (gate) return gate;
    }
  }

  // The voucher fields are the accountant's (accounting › receipts_confirm) and only at confirmation.
  const wantsVoucher = b.depositAccountId !== undefined || b.memo !== undefined || b.allocation !== undefined || b.branchId !== undefined;
  if (wantsVoucher && !(action === "approve" && key[0] === "accounting")) {
    return NextResponse.json(
      { error: "حساب الإيداع والوصف والتخصيص يحددها المحاسب عند التأكيد فقط.", errorEn: "The deposit account, memo and allocation are chosen by the accountant at confirmation only.", code: "VOUCHER_FIELDS" },
      { status: 400 },
    );
  }
  const allocation = parseAllocation(b.allocation);
  if (allocation === null) return NextResponse.json({ error: "التخصيص غير صالح: «تلقائي» أو قائمة فواتير ومبالغ.", errorEn: "allocation is \"AUTO\" or a list of { invoiceId, amount }." }, { status: 400 });
  const confirm: ConfirmFields = {
    ...(typeof b.depositAccountId === "string" && b.depositAccountId ? { depositAccountId: b.depositAccountId } : {}),
    ...(typeof b.memo === "string" ? { memo: b.memo } : {}),
    ...(allocation !== undefined ? { allocation } : {}),
    // «الموقع» (WP-B): the accountant may set the receipt's location at confirmation (null = «غير محدد»).
    ...(b.branchId === null || typeof b.branchId === "string" ? { branchId: (b.branchId as string | null) || null } : {}),
  };

  const reason = typeof b.reason === "string" ? b.reason : "";

  try {
    // Four-eyes on an accountant's receipt: the owner rule (receipt-four-eyes.ts), decided inside the service at confirm time.
    // An expired permission exception stops counting first (as the gate settles it on a request).
    if (row.source === "ACCOUNTANT" && row.submittedById === user.id) await settleExpiredOverrides();
    // Existence is checked inside the transaction, behind the row lock, so two callers
    // racing the same collection resolve against one another rather than against a read
    // each of them took before the other started.
    const result = await prisma.$transaction(async (tx) => {
      await setAuditContext(tx, auditFromRequest(request, user.id, reason || null));
      if (action === "approve") return approveCollection(tx, { collectionId: id, actorId: user.id, confirm });
      if (action === "reject") return rejectCollection(tx, { collectionId: id, actorId: user.id, reason });
      if (action === "return") return rejectCollection(tx, { collectionId: id, actorId: user.id, reason, reasonCode: "RETURN_FOR_CORRECTION" });
      return reverseCollection(tx, { collectionId: id, actorId: user.id, reason });
    }, TX_OPTS);

    // The deal's figures after the decision, so the screen does not have to refetch and
    // cannot briefly show the previous total. An accountant's receipt has no deal.
    const summary = row.opportunityId ? serialiseSummary(await collectionSummary(prisma, row.opportunityId)) : null;

    return NextResponse.json({ ...result, summary });
  } catch (err) {
    return handleDomainError(err);
  }
}
