// P0 C5 — «طلب تغيير المعاملة الضريبية» on a DRAFT quotation or invoice draft.
//   GET  ?documentType=QUOTE|INVOICE&documentId=… — the document's requests, newest first (who, what, why, the decision).
//   POST { documentType, documentId, lines: [{ key, taxCategory, taxRatePercent, exemptionReasonCode }], reason } — a
//        holder of sales › invoice_tax_override asks; a SECOND person (sales › invoice_tax_override_approve) decides at
//        POST /api/sales/tax-overrides/[id]/decision. Only legitimate ZATCA treatments (tax-override.ts).
// Both within the caller's customer scope (a document outside it is 404).
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { documentLines, mayApproveTaxOverride, requestTaxOverride } from "@/lib/services/sales/tax-override";
import { mayOverrideTax } from "@/lib/services/sales/direct-sale-terms";

type Viewer = Parameters<typeof customerInScope>[0];

async function docCustomer(type: unknown, id: unknown): Promise<string | null | undefined> {
  if (typeof id !== "string" || !id) return undefined;
  if (type === "QUOTE") {
    const q = await prisma.quote.findUnique({ where: { id }, select: { customerId: true, opportunity: { select: { customerId: true } } } });
    return q ? q.opportunity?.customerId ?? q.customerId ?? null : undefined;
  }
  if (type === "INVOICE") return (await prisma.salesInvoice.findUnique({ where: { id }, select: { customerId: true } }))?.customerId;
  return undefined;
}

async function visible(user: Viewer & { permissions: unknown }, type: unknown, id: unknown) {
  const c = await docCustomer(type, id);
  if (c === undefined) return false;
  return seesAllSales(user.permissions as never) || (!!c && (await customerInScope(user, c)));
}

export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const u = new URL(request.url);
  const type = u.searchParams.get("documentType"), id = u.searchParams.get("documentId");
  if (!(await visible(user, type, id))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
  const rows = await prisma.taxOverrideRequest.findMany({ where: { documentType: type!, documentId: id! }, orderBy: { requestedAt: "desc" }, take: 50 });
  const people = await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const name = (pid: string | null) => people.find((p) => p.id === pid)?.name ?? null;
  return NextResponse.json({
    can: { request: mayOverrideTax(user.permissions), approve: mayApproveTaxOverride(user.permissions) },
    // P0 gate M1: the draft's lines with their CONTENT keys (the form offers these; a request names one of them).
    lines: await documentLines(prisma, type as "QUOTE" | "INVOICE", id!),
    items: rows.map((r) => ({ id: r.id, status: r.status, lines: r.lines, reason: r.reason, requestedBy: name(r.requestedById), requestedById: r.requestedById, requestedAt: r.requestedAt.toISOString(), decidedBy: name(r.decidedById), decidedAt: r.decidedAt?.toISOString() ?? null, decisionNote: r.decisionNote })),
  });
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  let b: Record<string, unknown>;
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  try {
    if (!(await visible(user, b.documentType, b.documentId))) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });
    return NextResponse.json(await requestTaxOverride({ id: user.id, name: user.name, permissions: user.permissions }, { documentType: b.documentType, documentId: b.documentId, lines: b.lines, reason: b.reason }), { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
