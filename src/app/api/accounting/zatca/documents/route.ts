import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { prisma } from "@/lib/db";
import { zatcaError } from "@/lib/zatca/refusals";

export const dynamic = "force-dynamic";
const STATUSES = ["PENDING", "CLEARED", "CLEARED_WITH_WARNINGS", "REPORTED", "REPORTED_WITH_WARNINGS", "REJECTED", "ERROR"];

/**
 * GET /api/accounting/zatca/documents?status=&flow=&view=attention|overdue — the queue monitor: the e-invoices with
 * their invoice number, chain position, state, attempts, deadline and last error (never the XML). accounting › zatca_view.
 */
export async function GET(request: Request) {
  const { error } = await requireSub("accounting", "zatca_view");
  if (error) return error;
  try {
    const q = new URL(request.url).searchParams;
    const status = q.get("status"), flow = q.get("flow"), view = q.get("view");
    const where: Record<string, unknown> = {};
    if (status && STATUSES.includes(status)) where.status = status;
    if (flow === "CLEARANCE" || flow === "REPORTING") where.flow = flow;
    if (view === "attention") where.status = { in: ["PENDING", "REJECTED", "ERROR"] };
    if (view === "overdue") Object.assign(where, { flow: "REPORTING", status: { in: ["PENDING", "ERROR"] }, signedAt: { lt: new Date(Date.now() - 20 * 3_600_000) } });
    const rows = await prisma.zatcaDocument.findMany({
      where, orderBy: [{ signedAt: "desc" }], take: 200,
      select: { id: true, invoiceId: true, egsId: true, environment: true, icv: true, invoiceHash: true, flow: true, status: true, attempts: true, nextAttemptAt: true, lastHttpStatus: true, lastError: true, warnings: true, errors: true, signedAt: true, reportingDeadline: true, submittedAt: true, decidedAt: true },
    });
    const invs = await prisma.salesInvoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) } }, select: { id: true, number: true, kind: true, family: true, grandTotal: true, buyer: true } });
    const byId = new Map(invs.map((i) => [i.id, i]));
    return NextResponse.json({
      documents: rows.map((r) => {
        const i = byId.get(r.invoiceId);
        return { ...r, icv: r.icv.toString(), number: i?.number ?? null, kind: i?.kind ?? null, family: i?.family ?? null, grandTotal: i ? i.grandTotal.toFixed(2) : null, buyerName: (i?.buyer as { name?: string } | null)?.name ?? null };
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return zatcaError(err);
  }
}
