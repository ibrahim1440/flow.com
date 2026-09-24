import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { Decimal } from "@prisma/client/runtime/client";
import { accrueForCollection } from "@/lib/services/commissions/accrual";

/**
 * SANDBOX COLLECTION SOURCE — non-production only.
 *
 * This ERP has no invoice, payment or receivables model; that was verified against the
 * schema, not assumed. Commission is owed on money actually collected, so rather than build
 * a receivables system inside a CRM task, collection is an adapter and this route is its one
 * implementation: synthetic events, entered deliberately, for demonstrating and testing the
 * commission cycle.
 *
 * Three separate gates, because any one of them alone is a single point of failure:
 *
 *   1. SALES_SANDBOX_COLLECTIONS must be exactly "true" in the running configuration.
 *   2. The database host must not be one of the known production endpoints.
 *   3. The caller needs commissions/sandbox_collections, which is NOT granted to a sales
 *      role by default — a rep must not be able to manufacture a collection that looks
 *      verified and then be paid on it.
 *
 * Every row is stamped sourceSystem = "SANDBOX" so a future real integration can never be
 * confused with this, and the screens say so rather than implying a live figure.
 */

const PROTECTED_DB_HOSTS = [
  "ep-dawn-dust-aqn1u1uf",
  "ep-jolly-feather-aqne6cp1",
  "ep-icy-field-aq4upc3z",
];

/**
 * Refuse unless the running configuration proves this is a disposable environment.
 *
 * Fail-closed: an unset flag or an unreadable URL is a refusal, never a default-allow. The
 * host check is a second line of defence and not the only one, because a denylist can only
 * ever name the production systems somebody remembered.
 */
function sandboxGate(): { ok: true } | { ok: false; status: number; message: string } {
  if (process.env.SALES_SANDBOX_COLLECTIONS !== "true") {
    return {
      ok: false,
      status: 403,
      message:
        "The sandbox collection source is disabled in this environment. It exists to demonstrate " +
        "the commission cycle in a disposable environment and is never enabled where real money is tracked.",
    };
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    return { ok: false, status: 500, message: "No database is configured." };
  }
  for (const host of PROTECTED_DB_HOSTS) {
    if (url.includes(host)) {
      return {
        ok: false,
        status: 403,
        message: "This database is a protected environment. Sandbox collections cannot be recorded against it.",
      };
    }
  }
  return { ok: true };
}

export async function POST(request: Request) {
  const { user, error } = await requireSub("commissions", "sandbox_collections");
  if (error) return error;

  const gate = sandboxGate();
  if (!gate.ok) return NextResponse.json({ error: gate.message, sandbox: true }, { status: gate.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const externalRef = typeof b.externalRef === "string" ? b.externalRef.trim() : "";
  if (externalRef.length < 3) {
    return NextResponse.json(
      { error: "externalRef is required — it is what makes a re-delivered event recognisable rather than paid twice." },
      { status: 400 },
    );
  }

  const num = (v: unknown, field: string): Decimal => {
    const d = new Decimal(typeof v === "number" || typeof v === "string" ? v : 0);
    if (d.isNegative()) throw { _appCode: 400, message: `${field} cannot be negative.` };
    return d;
  };

  try {
    const amountGross = num(b.amountGross, "amountGross");
    const amountTax = num(b.amountTax ?? 0, "amountTax");
    const amountNonQualifying = num(b.amountNonQualifying ?? 0, "amountNonQualifying");
    if (amountGross.isZero()) {
      return NextResponse.json({ error: "amountGross must be greater than zero." }, { status: 400 });
    }
    if (amountTax.plus(amountNonQualifying).greaterThan(amountGross)) {
      return NextResponse.json(
        { error: "Tax plus the non-qualifying portion cannot exceed the amount collected." },
        { status: 400 },
      );
    }

    const currency = typeof b.currency === "string" ? b.currency : "SAR";
    if (currency !== "SAR") {
      return NextResponse.json(
        {
          error:
            `Collections are only handled in SAR; this one says ${currency}. There is no exchange-rate ` +
            "policy configured, so a commission figure would have to be invented.",
        },
        { status: 409 },
      );
    }

    const opportunityId = typeof b.opportunityId === "string" ? b.opportunityId : null;
    if (opportunityId) {
      const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { id: true } });
      if (!opp) return NextResponse.json({ error: "That deal no longer exists." }, { status: 404 });
    }

    const result = await prisma.$transaction(async (tx) => {
      // The unique key on (sourceSystem, externalRef) is the final arbiter for two
      // deliveries of one payment. The loser of the insert race reads the winner's row and
      // accrues nothing new, which is the behaviour a retrying webhook needs.
      const existing = await tx.collectionEvent.findUnique({
        where: { sourceSystem_externalRef: { sourceSystem: "SANDBOX", externalRef } },
        select: { id: true },
      });
      if (existing) {
        const outcomes = await accrueForCollection(tx, existing.id, user.id);
        return { collectionEventId: existing.id, replayed: true, accruals: outcomes };
      }

      const created = await tx.collectionEvent.create({
        data: {
          sourceSystem: "SANDBOX",
          externalRef,
          status: "RECORDED",
          customerId: typeof b.customerId === "string" ? b.customerId : null,
          opportunityId,
          orderId: typeof b.orderId === "string" ? b.orderId : null,
          amountGross,
          amountTax,
          amountNonQualifying,
          currency,
          collectedAt: typeof b.collectedAt === "string" ? new Date(b.collectedAt) : new Date(),
          note: typeof b.note === "string" ? b.note.trim() || null : null,
          createdById: user.id,
        },
        select: { id: true },
      });

      const outcomes = await accrueForCollection(tx, created.id, user.id);
      return { collectionEventId: created.id, replayed: false, accruals: outcomes };
    }, TX_OPTS);

    return NextResponse.json(
      {
        ...result,
        sourceSystem: "SANDBOX",
        // Repeated in the payload so a screen cannot render this as a verified figure by
        // forgetting to look it up.
        notice: "Synthetic collection recorded by the sandbox source. No real payment was received.",
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) {
      const e = err as { _appCode: number; message: string };
      return NextResponse.json({ error: e.message }, { status: e._appCode });
    }
    return handlePrismaError(err);
  }
}

/** GET — the sandbox's own events, so a reviewer can see what the figures came from. */
export async function GET() {
  const { error } = await requireSub("commissions", "sandbox_collections");
  if (error) return error;

  const gate = sandboxGate();
  if (!gate.ok) return NextResponse.json({ error: gate.message, sandbox: true }, { status: gate.status });

  try {
    const rows = await prisma.collectionEvent.findMany({
      where: { sourceSystem: "SANDBOX" },
      orderBy: { collectedAt: "desc" },
      take: 100,
      select: {
        id: true, externalRef: true, status: true, amountGross: true, amountTax: true,
        amountNonQualifying: true, currency: true, collectedAt: true, note: true,
        customer: { select: { id: true, name: true } },
      },
    });
    return NextResponse.json({ rows, sourceSystem: "SANDBOX", sandbox: true });
  } catch (err) {
    return handlePrismaError(err);
  }
}
