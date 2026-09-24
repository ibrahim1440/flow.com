import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import { toCsv, LEAD_IMPORT_COLUMNS } from "@/lib/services/sales/csv";

/**
 * GET /api/sales/leads/export — the lead list as a CSV file.
 *
 * Three things this endpoint is careful about.
 *
 * **It is a privilege of its own** (`lead_export`). Reading leads a screen at a time and
 * downloading the whole list are different acts: the second one is how a customer list
 * leaves a company, and it should be grantable separately from ordinary use.
 *
 * **It is scoped exactly as the list is.** A rep exports their own leads. Exporting
 * everybody's additionally needs the privilege that lets them see everybody's — otherwise
 * this endpoint would be a way around the scoping the list screen enforces.
 *
 * **It neutralises spreadsheet formulas.** The lead API stores text verbatim on purpose, so
 * a `notes` field really can begin with `=`. `toCsv` prefixes those, because the person who
 * opens the export is a colleague and the file is opened in Excel.
 */
export async function GET(request: Request) {
  const { user, error } = await requireSub("sales", "lead_export");
  if (error) return error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const scopeAll = seesAllSales(user.permissions);

  try {
    const rows = await prisma.lead.findMany({
      where: {
        ...(scopeAll ? {} : { ownerId: user.id }),
        ...(status ? { status: status as never } : {}),
      },
      orderBy: { createdAt: "desc" },
      // A bound rather than everything. An unbounded export of a growing table is a request
      // that gets slower every month until one day it times out mid-download.
      take: 5000,
      select: {
        companyName: true, companyNameAr: true, contactName: true, phone: true, email: true,
        city: true, address: true, source: true, sourceNote: true, notes: true,
        nextFollowUpAt: true, status: true, createdAt: true,
        owner: { select: { name: true } },
      },
    });

    // The import columns first, in their exact order, so an export can be edited and fed
    // straight back in. The trailing three are read-only context and the importer ignores
    // any column it does not recognise, which it reports rather than silently dropping.
    const header = [...LEAD_IMPORT_COLUMNS, "status", "owner", "createdAt"];
    const body = rows.map((r) => [
      r.companyName,
      r.companyNameAr ?? "",
      r.contactName,
      r.phone ?? "",
      r.email ?? "",
      r.city ?? "",
      r.address ?? "",
      r.source,
      r.sourceNote ?? "",
      r.notes ?? "",
      r.nextFollowUpAt ? r.nextFollowUpAt.toISOString().slice(0, 10) : "",
      r.status,
      r.owner?.name ?? "",
      r.createdAt.toISOString().slice(0, 10),
    ]);

    const csv = toCsv(header, body);
    const stamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads-${scopeAll ? "all" : "mine"}-${stamp}.csv"`,
        // Nothing about a customer list belongs in a shared cache.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
