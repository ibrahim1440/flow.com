import type { Prisma, SupplierBillStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { accountingRoute, body, query } from "@/lib/accounting/http";
import { createBill } from "@/lib/accounting/payables-service";
import { agingBucket } from "@/lib/accounting/stage2-service";
import { todayAccountingDate } from "@/lib/accounting/dates";
import { dec, ZERO } from "@/lib/accounting/money";
import { parseBillBody } from "./parse";

const STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "POSTED", "REVERSED"]);

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const today = todayAccountingDate();
  const where: Prisma.SupplierBillWhereInput = {};
  const st = q.get("status");
  if (st === "PENDING") where.status = { in: ["SUBMITTED", "APPROVED"] };
  else if (st === "OVERDUE") { where.status = "POSTED"; where.dueDate = { lt: today }; }
  else if (st && STATUSES.has(st)) where.status = st as SupplierBillStatus;
  if (q.get("supplierId")) where.supplierId = q.get("supplierId")!;
  const text = q.get("q")?.trim();
  if (text) {
    const n = Number(text.replace(/^ف-?/, ""));
    where.OR = [{ supplierInvoiceNo: { contains: text, mode: "insensitive" } }, { supplier: { name: { contains: text, mode: "insensitive" } } }, ...(Number.isInteger(n) && n > 0 ? [{ billNo: n }] : [])];
  }
  const page = Math.max(Number(q.get("page")) || 1, 1);
  const pageSize = Math.min(Math.max(Number(q.get("pageSize")) || 25, 10), 100);
  const [rows, total, counts] = await Promise.all([
    prisma.supplierBill.findMany({ where, orderBy: { billNo: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { supplier: { select: { name: true, vatNumber: true } } } }),
    prisma.supplierBill.count({ where }),
    prisma.supplierBill.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const obIds = rows.map((r) => r.obligationId).filter(Boolean) as string[];
  const paidRows = obIds.length ? await prisma.bankTransactionMatch.groupBy({ by: ["targetId"], where: { targetType: "OBLIGATION", targetId: { in: obIds }, active: true, transaction: { status: { not: "VOID" } } }, _sum: { amount: true } }) : [];
  const paid = new Map(paidRows.map((p) => [p.targetId, dec(p._sum.amount)]));
  const overdue = await prisma.supplierBill.count({ where: { status: "POSTED", dueDate: { lt: today } } });
  return {
    total, page, pageSize,
    counts: { ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])), OVERDUE: overdue },
    rows: rows.map((r) => {
      const remaining = r.status === "POSTED" ? dec(r.totalGross).sub(paid.get(r.obligationId ?? "") ?? ZERO) : null;
      return {
        id: r.id, billNo: r.billNo, kind: r.kind, supplier: r.supplier.name, supplierHasVat: !!r.supplier.vatNumber, supplierInvoiceNo: r.supplierInvoiceNo,
        billDate: r.billDate, dueDate: r.dueDate, status: r.status, totalNet: r.totalNet, totalVat: r.totalVat, totalGross: r.totalGross,
        remaining: remaining?.toFixed(2) ?? null, rejectedReason: r.rejectedReason,
        overdueDays: r.status === "POSTED" && remaining?.gt(0) && agingBucket(r.dueDate, today) !== "current" ? Math.floor((today.getTime() - r.dueDate.getTime()) / 86_400_000) : 0,
      };
    }),
  };
});

export const POST = accountingRoute("ap_bill_create", async ({ user, request }) => createBill(parseBillBody(await body(request)), user.id), 201);
