import type { Prisma, SalesInvoiceStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { accountingRoute, body, query } from "@/lib/accounting/http";
import { createSalesDoc, invoiceBalances } from "@/lib/accounting/receivables-service";
import { agingBucket } from "@/lib/accounting/stage2-service";
import { todayAccountingDate } from "@/lib/accounting/dates";
import { dec, ZERO } from "@/lib/accounting/money";
import { parseSalesBody } from "../parse";

const STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "POSTED", "REVERSED"]);

/** Posted invoices past their due date that are still (partly) unpaid — paid ones are not overdue. */
async function overdueIds(today: Date) {
  const due = await prisma.salesInvoice.findMany({ where: { status: "POSTED", kind: "INVOICE", dueDate: { lt: today } }, select: { id: true, totalGross: true } });
  const bal = await invoiceBalances(prisma, due.map((d) => d.id));
  return due.filter((d) => dec(d.totalGross).gt(bal.get(d.id)?.settled ?? ZERO)).map((d) => d.id);
}

export const GET = accountingRoute(null, async ({ request }) => {
  const q = query(request);
  const today = todayAccountingDate();
  const overdue = await overdueIds(today);
  const where: Prisma.SalesInvoiceWhereInput = {};
  const st = q.get("status");
  if (st === "PENDING") where.status = { in: ["SUBMITTED", "APPROVED"] };
  else if (st === "OVERDUE") where.id = { in: overdue };
  else if (st && STATUSES.has(st)) where.status = st as SalesInvoiceStatus;
  if (q.get("kind") === "CREDIT_NOTE" || q.get("kind") === "INVOICE") where.kind = q.get("kind") as "INVOICE";
  if (q.get("customerId")) where.customerId = q.get("customerId")!;
  const text = q.get("q")?.trim();
  if (text) {
    const n = Number(text.replace(/^(INV|CN)-?/i, ""));
    where.OR = [{ customer: { name: { contains: text, mode: "insensitive" } } }, { customer: { nameAr: { contains: text, mode: "insensitive" } } }, ...(Number.isInteger(n) && n > 0 ? [{ invoiceNo: n }] : [])];
  }
  const page = Math.max(Number(q.get("page")) || 1, 1);
  const pageSize = Math.min(Math.max(Number(q.get("pageSize")) || 25, 10), 100);
  const [rows, total, counts] = await Promise.all([
    prisma.salesInvoice.findMany({ where, orderBy: { invoiceNo: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { customer: { select: { name: true, nameAr: true, vatNumber: true } }, originalInvoice: { select: { invoiceNo: true } } } }),
    prisma.salesInvoice.count({ where }),
    prisma.salesInvoice.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const orders = new Map((await prisma.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter(Boolean) as string[] } }, select: { id: true, orderNumber: true } })).map((o) => [o.id, o.orderNumber]));
  const bal = await invoiceBalances(prisma, rows.map((r) => r.id));
  return {
    total, page, pageSize,
    counts: { ...Object.fromEntries(counts.map((c) => [c.status, c._count._all])), OVERDUE: overdue.length },
    rows: rows.map((r) => {
      const b = bal.get(r.id);
      const open = r.status === "POSTED" && r.kind === "INVOICE" ? dec(r.totalGross).sub(b?.settled ?? ZERO) : null;
      return {
        id: r.id, invoiceNo: r.invoiceNo, kind: r.kind, customer: r.customer.nameAr ?? r.customer.name, customerHasVat: !!r.customer.vatNumber,
        orderNumber: r.orderId ? orders.get(r.orderId) ?? null : null, originalInvoiceNo: r.originalInvoice?.invoiceNo ?? null,
        issueDate: r.issueDate, dueDate: r.dueDate, status: r.status, totalNet: r.totalNet, totalVat: r.totalVat, totalGross: r.totalGross,
        open: open?.toFixed(2) ?? null, awaitingReceipt: open ? (b?.awaiting ?? ZERO).toFixed(2) : null, rejectedReason: r.rejectedReason,
        overdueDays: open?.gt(0) && agingBucket(r.dueDate, today) !== "current" ? Math.floor((today.getTime() - r.dueDate.getTime()) / 86_400_000) : 0,
      };
    }),
  };
});

export const POST = accountingRoute("ar_invoice_create", async ({ user, request }) => createSalesDoc(parseSalesBody(await body(request)), user.id), 201);
