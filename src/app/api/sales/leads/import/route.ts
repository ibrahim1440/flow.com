import { NextResponse } from "next/server";
import { prisma, TX_OPTS } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesAllSales } from "@/lib/services/sales/scope";
import { parseLeadCsv, MAX_IMPORT_ROWS } from "@/lib/services/sales/csv";
import { normalizationFor, normalizeCompany, normalizePhone } from "@/lib/services/sales/leads";

/**
 * POST /api/sales/leads/import — bulk-create leads from a CSV.
 *
 * ── Validate everything, then write everything, or write nothing ──
 * The whole file is parsed and checked before a single row is inserted, and the insert runs
 * in one transaction. A half-applied import is the worst outcome available: the operator
 * cannot tell which rows landed, so they either re-upload and double the good ones or edit
 * 200 rows by hand.
 *
 * ── Duplicates are reported, not merged and not dropped ──
 * Same rule as the single-lead path. A phone already in the system is a strong signal, so
 * those rows are held back and listed; the operator re-submits with `acknowledgeDuplicates`
 * if they really are different people at the same café. Two rows in the FILE sharing a phone
 * are caught too — an exported-and-re-imported list is the ordinary way that happens.
 *
 * ── Ownership ──
 * Imported leads belong to the importer unless they may assign, exactly as a typed-in lead
 * does. Otherwise a CSV would be a way to plant leads on a colleague, and commission follows
 * ownership.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_import");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const csv = typeof b.csv === "string" ? b.csv : "";
  if (!csv.trim()) {
    return NextResponse.json({ error: "No file content was sent." }, { status: 400 });
  }
  // A bound on the raw payload as well as on the row count: the row limit only applies once
  // the text has been parsed, and parsing is itself work.
  if (csv.length > 2_000_000) {
    return NextResponse.json(
      { error: `That file is too large. Split it into files of at most ${MAX_IMPORT_ROWS} rows.` },
      { status: 413 },
    );
  }

  const acknowledgeDuplicates = b.acknowledgeDuplicates === true;
  const dryRun = b.dryRun === true;

  try {
    const parsed = parseLeadCsv(csv);

    if (parsed.rows.length === 0) {
      return NextResponse.json(
        {
          imported: 0,
          problems: parsed.problems,
          unknownColumns: parsed.unknownColumns,
          error: parsed.problems[0]?.message ?? "No usable rows were found in that file.",
        },
        { status: 400 },
      );
    }

    const canAssign = seesAllSales(user.permissions);
    let ownerId = user.id;
    if (typeof b.ownerId === "string" && b.ownerId && b.ownerId !== user.id) {
      if (!canAssign) {
        return NextResponse.json(
          { error: "Importing leads for another employee needs the lead-assign permission." },
          { status: 403 },
        );
      }
      const target = await prisma.employee.findUnique({
        where: { id: b.ownerId },
        select: { id: true, active: true },
      });
      if (!target || !target.active) {
        return NextResponse.json({ error: "That employee cannot own a lead." }, { status: 400 });
      }
      ownerId = b.ownerId;
    }

    // ── Duplicates within the file itself ──
    const seenPhones = new Map<string, number>();
    const withinFile: { row: number; message: string }[] = [];
    parsed.rows.forEach((r, i) => {
      const phone = normalizePhone(r.phone);
      if (!phone) return;
      const first = seenPhones.get(phone);
      if (first !== undefined) {
        withinFile.push({
          row: i + 2,
          message: `The same phone number appears on row ${first + 2} of this file.`,
        });
      } else {
        seenPhones.set(phone, i);
      }
    });

    // ── Duplicates against what is already stored ──
    const phones = [...seenPhones.keys()];
    const companies = [...new Set(parsed.rows.map((r) => normalizeCompany(r.companyName!)).filter(Boolean))];
    const existing =
      phones.length || companies.length
        ? await prisma.lead.findMany({
            where: {
              status: { not: "CONVERTED" },
              OR: [
                ...(phones.length ? [{ normalizedPhone: { in: phones } }] : []),
                ...(companies.length ? [{ normalizedCompany: { in: companies } }] : []),
              ],
            },
            select: { id: true, companyName: true, contactName: true, normalizedPhone: true, normalizedCompany: true },
          })
        : [];
    const byPhone = new Map(existing.filter((e) => e.normalizedPhone).map((e) => [e.normalizedPhone!, e]));

    const strongDuplicates: {
      row: number;
      companyName: string;
      matchesLeadId: string;
      matchesCompany: string;
    }[] = [];
    parsed.rows.forEach((r, i) => {
      const phone = normalizePhone(r.phone);
      const hit = phone ? byPhone.get(phone) : undefined;
      if (hit) {
        strongDuplicates.push({
          row: i + 2,
          companyName: r.companyName!,
          matchesLeadId: hit.id,
          matchesCompany: hit.companyName,
        });
      }
    });

    const blockedRows = new Set<number>([
      ...withinFile.map((w) => w.row),
      ...(acknowledgeDuplicates ? [] : strongDuplicates.map((d) => d.row)),
    ]);

    const toInsert = parsed.rows.filter((_r, i) => !blockedRows.has(i + 2));

    // A dry run answers "what would this do" without doing it, which is what the import
    // screen shows before the operator commits.
    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        wouldImport: toInsert.length,
        rowsRead: parsed.rows.length,
        problems: parsed.problems,
        duplicatesInFile: withinFile,
        duplicatesInSystem: strongDuplicates,
        unknownColumns: parsed.unknownColumns,
        ownerId,
      });
    }

    if (toInsert.length === 0) {
      return NextResponse.json(
        {
          imported: 0,
          problems: parsed.problems,
          duplicatesInFile: withinFile,
          duplicatesInSystem: strongDuplicates,
          unknownColumns: parsed.unknownColumns,
          error:
            "Every row was held back. Resolve the duplicates, or resend with " +
            "acknowledgeDuplicates to import them anyway.",
        },
        { status: 409 },
      );
    }

    // One transaction: all of the accepted rows, or none of them.
    const created = await prisma.$transaction(
      async (tx) =>
        tx.lead.createMany({
          data: toInsert.map((r) => ({
            companyName: r.companyName!,
            companyNameAr: r.companyNameAr ?? null,
            contactName: r.contactName!,
            phone: r.phone ?? null,
            email: r.email ?? null,
            city: r.city ?? null,
            address: r.address ?? null,
            source: (r.source ?? "OTHER") as never,
            sourceNote: r.sourceNote ?? null,
            notes: r.notes ?? null,
            nextFollowUpAt: r.nextFollowUpAt ? new Date(r.nextFollowUpAt) : null,
            ownerId,
            createdById: user.id,
            ...normalizationFor({ companyName: r.companyName!, phone: r.phone ?? null }),
          })),
        }),
      TX_OPTS,
    );

    return NextResponse.json(
      {
        imported: created.count,
        rowsRead: parsed.rows.length,
        skipped: parsed.rows.length - created.count,
        problems: parsed.problems,
        duplicatesInFile: withinFile,
        duplicatesInSystem: strongDuplicates,
        unknownColumns: parsed.unknownColumns,
        ownerId,
      },
      { status: 201 },
    );
  } catch (err) {
    return handleDomainError(err);
  }
}
