import { NextResponse } from "@/lib/api-response";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { extractIp, hashRateLimitKey, pruneExpired, isIpRateLimited, isPairRateLimited, recordFailedAttempt, clearAttempts } from "@/lib/rate-limit";
import { handlePrismaError } from "@/lib/api-error";
import { deleteCustomerFileBlobs } from "@/lib/services/customers/files";
import { evaluateResetAuthorization, resetRefusalBody } from "@/lib/reset-safety";
import { validatePin } from "@/lib/pin-policy";
import { pinVerifierInput, requirePinLookupSecret } from "@/lib/pin-lookup";

const CONFIRM_PHRASE = "CLEAR DEMO DATA";

export async function POST(request: Request) {
  try {
    const ip = extractIp(request);

    // Layer 1: settings.training_reset sub-privilege required (admin only by default)
    const { user, error } = await requireSub("settings", "training_reset");
    if (error) return error;


    // ── Environment / database safety boundary ─────────────────────────────
    // Deliberately placed here: after authorization, so an anonymous caller learns nothing
    // about how this deployment is configured, but before pruneExpired() below, which
    // deletes expired rate-limit rows. A refusal must leave every table in the database
    // untouched, and "every table" includes the bookkeeping ones.
    //
    // Privilege, confirmation phrase and PIN prove that a human meant to do this. They
    // cannot prove WHICH database is about to be emptied — the same admin holds the same
    // privilege in production — so a training-data reset is refused outright unless the running
    // configuration explicitly names this host AND this database as disposable.
    const auth = evaluateResetAuthorization(process.env);
    if (!auth.allowed) {
      return NextResponse.json(resetRefusalBody(auth.reason), { status: 403 });
    }

    const ipHash = hashRateLimitKey(ip);
    const identifierHash = hashRateLimitKey("training-reset:" + user.id);
    await pruneExpired();
    if (await isIpRateLimited(ipHash, 10)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }
    if (await isPairRateLimited(ipHash, identifierHash, 5)) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }

    const { phrase, pin } = await request.json();

    // Layer 2: confirmation phrase must match exactly
    if (phrase !== CONFIRM_PHRASE) {
      return NextResponse.json({ error: "Confirmation phrase is incorrect" }, { status: 400 });
    }

    // Layer 3: admin PIN re-verify
    // The re-verified PIN is shape-checked before it reaches bcrypt. Two reasons, and
    // neither is cosmetic: compare() throws on a non-string, which on a destructive
    // endpoint would surface as an unexplained 500 instead of a refusal; and this gate
    // has to demand the SAME credential shape every path that sets a PIN now enforces,
    // so a stale pre-cutover PIN cannot authorise a whole-database deletion.
    // Counted as a failed attempt so a script cannot probe the endpoint for free.
    const pinShape = validatePin(pin);
    if (!pinShape.ok) {
      await recordFailedAttempt(ipHash, identifierHash);
      return NextResponse.json({ error: pinShape.message }, { status: 400 });
    }
    // Verified over pinVerifierInput, exactly as login and every other PIN path: the stored
    // hash is bcrypt(pinVerifierInput(pin)), so a raw-PIN compare here would refuse the
    // admin's own PIN and, on a legacy row, would be the one place a raw-PIN verifier crept
    // back in — on the endpoint that clears the demo dataset.
    const admin = await prisma.employee.findUnique({ where: { id: user.id } });
    if (!admin || !(await compare(pinVerifierInput(pinShape.pin, requirePinLookupSecret()), admin.pin))) {
      await recordFailedAttempt(ipHash, identifierHash);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    await clearAttempts(ipHash, identifierHash);

    // FK-safe deletion in order.
    // Extends production reset scope by also deleting catalog/master data:
    // ProductSKU (before CoffeeProduct), CoffeeProduct, Supplier.
    // Preserved: Employee, SystemConfig, LoginAttempt, RateLimit.
    // CustomerRoastPreference cascades from Customer (onDelete: Cascade) — no explicit delete needed.
    // CoffeeProduct.defaultGreenBeanId is nullable — SET NULL applied when GreenBean is deleted.
    // Customer files kept in the private Blob store go with their customers: listed before the
    // reset, removed after it commits (best effort — a failure is a storage incident, not a 500).
    const blobs = await prisma.customerFile.findMany({ where: { blobPathname: { not: null } }, select: { blobPathname: true } });
    await prisma.$transaction([
      prisma.cuppingScore.deleteMany(),
      prisma.cuppingSessionBatch.deleteMany(),
      prisma.cuppingSession.deleteMany(),
      prisma.inventoryMovement.deleteMany(),
      // Phase D: DeliveryLine.finishedGoodsLotId is ON DELETE RESTRICT too, so the lines go
      // before the lots (their deliveries would cascade them, but only after the lots).
      prisma.deliveryLine.deleteMany(),
      // Must precede finishedGoodsLot: StockAllocation.finishedGoodsLotId is ON DELETE
      // RESTRICT, so leaving these behind makes the whole reset transaction fail.
      prisma.stockAllocation.deleteMany(),
      prisma.finishedGoodsLot.deleteMany(),
      prisma.productionOrder.deleteMany(),
      prisma.purchaseRecord.deleteMany(),
      prisma.qcRecord.deleteMany(),
      // Guest invitations of the QC panel (20261023090000_production_qc_simplify); before the batches.
      prisma.qcInvite.deleteMany(),
      prisma.delivery.deleteMany(),
      prisma.blendIngredient.deleteMany(),
      // Reachable ONLY behind the authorization above, which is what makes it acceptable:
      // this is the deliberate destruction of disposable data, not the erasure of a
      // customer's packaging audit trail. PackagingOperation.batchId is ON DELETE RESTRICT,
      // so it must precede the batches it refers to — and because both statements are in
      // the one transaction below, the pair either both happen or neither does.
      prisma.packagingOperation.deleteMany(),
      prisma.roastingBatch.deleteMany(),
      // 20261030100000_station_w4: the packaging station's picks and dispatch handoffs describe the
      // orders cleared next (they would cascade with them; named so the list says every table it clears).
      prisma.dispatchHandoffLine.deleteMany(),
      prisma.preparationPick.deleteMany(),
      prisma.dispatchHandoff.deleteMany(),
      prisma.orderItem.deleteMany(),
      prisma.order.deleteMany(),
      // 20261028100000_credit_hold: the customers' holds and credit log (they would cascade with the
      // customers; deleted explicitly so the reset's list names every table it clears).
      prisma.customerCreditLog.deleteMany(),
      prisma.customerSalesHold.deleteMany(),
      prisma.customer.deleteMany(),
      prisma.greenBean.deleteMany(),
      // 20261029090000_notifications: the notifications describe the records cleared above (orders,
      // customers, batches …) and the credit standing watch follows the customers; the people's
      // e-mail preferences are kept with the people.
      prisma.notification.deleteMany(),
      prisma.notificationWatch.deleteMany(),
      // 20261029100000_blob_client_upload: the direct-upload slots (CustomerFileUpload) are NOT cleared —
      // a slot outlives its customer by design so the orphan sweep still deletes its blob (an hour on).
      prisma.productSKU.deleteMany(),
      prisma.coffeeProduct.deleteMany(),
      prisma.supplier.deleteMany(),
    ]);
    await deleteCustomerFileBlobs(prisma, blobs.map((b) => b.blobPathname));

    return NextResponse.json({ success: true, message: "Training data reset completed successfully." });
  } catch (err) {
    return handlePrismaError(err);
  }
}
