import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { financeHandler } from "@/lib/finance/server/http";
import { FinanceError } from "@/lib/finance/server/context";
import { budgetReport } from "@/lib/finance/server/budgets";
import { cashForecast } from "@/lib/finance/server/dashboard";
import { listCategories } from "@/lib/finance/server/allocation";
import { listTransactions } from "@/lib/finance/server/transactions";
import { fromMinor, toMinor } from "@/lib/finance/money";

type Sheet = { name: string; columns: string[]; rows: (string | number | null)[][] };

// Amounts are exported as fixed two-decimal strings converted once to numbers for Excel
// cells, and as exact strings in CSV — never re-computed here.
const n = (minor: number | null) => (minor === null ? null : Number(fromMinor(minor)));

async function buildSheet(kind: string, args: Parameters<Parameters<typeof financeHandler>[1]>[0]): Promise<Sheet> {
  const { scope, query } = args;
  switch (kind) {
    case "budget": {
      const id = query.get("id");
      if (!id) throw new FinanceError("id is required.", 400);
      const r = await budgetReport(prisma, scope, id, query.get("date") ?? undefined);
      return {
        name: `Budget ${r.budget.month}`,
        columns: ["Kind", "Code", "Category", "Original approved", "Revised approved", "Planned to date", "Actual to date", "Variance", "Variance %", "State", "Open commitments", "Remaining forecast", "Forecast at completion", "Forecast variance", "Owner", "Explanation"],
        rows: r.rows.map((x) => [
          x.kind, x.code, x.nameEn, n(x.originalApproved), n(x.revisedApproved), n(x.plannedToDate), n(x.actualToDate), n(x.toDate.variance),
          x.toDate.percentBp === null ? null : x.toDate.percentBp / 100, x.toDate.state, n(x.openCommitments), n(x.remainingForecast), n(x.fac),
          n(x.forecastVariance.variance), x.ownerName, x.note?.explanation ?? null,
        ]),
      };
    }
    case "forecast": {
      const f = await cashForecast(prisma, scope);
      return {
        name: "13-week forecast",
        columns: ["Week", "Start", "End", "Opening", "Receipts", "Payments", "Closing", "Conservative closing"],
        rows: f.base.weeks.map((w, i) => [w.index, w.start, w.end, n(w.opening), n(w.receipts), n(w.payments), n(w.closing), n(f.conservative.weeks[i].closing)]),
      };
    }
    case "categories": {
      const cats = await listCategories(prisma, scope, query.get("month") ?? undefined);
      return {
        name: "Allocation categories",
        columns: ["Code", "Name", "Opening carried", "Allocations", "Incoming adjustments", "Payments", "Outgoing adjustments", "Balance", "Reserved", "Available"],
        rows: cats.map((c) => [c.code, c.nameEn, n(c.openingCarried), n(c.allocations), n(c.incoming), n(c.payments), n(c.outgoing), n(c.balance), n(c.reserved), n(c.available)]),
      };
    }
    case "transactions": {
      query.set("take", "200");
      const all: (string | number | null)[][] = [];
      for (let skip = 0; skip < 10_000; skip += 200) {
        query.set("skip", String(skip));
        const page = await listTransactions(prisma, scope, query);
        all.push(...page.rows.map((t) => [t.txnDate.toISOString().slice(0, 10), t.cashAccount.code, n(toMinor(t.amount)), t.status, t.classification, t.reviewStatus, t.bankReference, t.description]));
        if (page.rows.length < 200) break;
      }
      return { name: "Bank lines", columns: ["Date", "Account", "Amount", "Status", "Classification", "Review", "Reference", "Description"], rows: all };
    }
    default:
      throw new FinanceError("Unknown export.", 400);
  }
}

function csvCell(v: string | number | null) {
  if (v === null) return "";
  const s = String(v);
  // Neutralise spreadsheet formula injection from free-text fields.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const GET = financeHandler(undefined, async (args) => {
  const kind = args.query.get("kind") ?? "";
  const format = args.query.get("format") === "csv" ? "csv" : "xlsx";
  const sheet = await buildSheet(kind, args);
  const file = `finance-${kind}-${new Date().toISOString().slice(0, 10)}`;
  if (format === "csv") {
    const text = "﻿" + [sheet.columns, ...sheet.rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    return new Response(text, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file}.csv"`, "Cache-Control": "private, no-store" } });
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.name.slice(0, 31));
  ws.addRow(sheet.columns).font = { bold: true };
  sheet.rows.forEach((r) => ws.addRow(r.map((v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v))));
  ws.columns.forEach((c) => { c.width = 18; });
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${file}.xlsx"`, "Cache-Control": "private, no-store" } });
});
