import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule, requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { refuse } from "@/lib/accounting/refusals";
import { auditFromRequest } from "@/lib/accounting/audit";
import { deleteManualJournalDraft, updateManualJournalDraft } from "@/lib/accounting/journal-service";
import { parseJournalBody } from "@/lib/accounting/journal-input";
import { postingRef } from "@/lib/accounting/posting-engine";
import { sourceHref } from "@/lib/accounting/reports";
import { dayText } from "@/lib/accounting/dates";

type Params = { params: Promise<{ id: string }> };

/** One journal: lines (account, dimensions), period, reversal links, the source link and its audit trail. */
export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: { include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true, type: true, controlType: true } } }, orderBy: [{ lineNo: "asc" }, { id: "asc" }] },
        fiscalPeriod: true,
        reversesEntry: { select: { id: true, entryNo: true, postingYear: true, postingSeq: true } },
        reversedByEntry: { select: { id: true, entryNo: true, postingYear: true, postingSeq: true, entryDate: true } },
      },
    });
    if (!entry) throw refuse("NOT_FOUND");
    const audit = await prisma.accountingAuditLog.findMany({ where: { entityType: "JournalEntry", entityId: id }, orderBy: { at: "asc" }, select: { id: true, at: true, actorId: true, action: true, reason: true, ip: true, userAgent: true } });
    const ids = [entry.createdBy, entry.submittedBy, entry.approvedBy, entry.postedBy, entry.reversedBy, entry.rejectedBy, ...audit.map((a) => a.actorId)].filter((x): x is string => !!x);
    const people = await prisma.employee.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return NextResponse.json({
      ...entry,
      ref: postingRef(entry),
      entryDate: dayText(entry.entryDate),
      sourceHref: sourceHref(entry.sourceType, entry.sourceId, entry.sourceModule),
      reversesEntry: entry.reversesEntry ? { ...entry.reversesEntry, ref: postingRef(entry.reversesEntry) } : null,
      reversedByEntry: entry.reversedByEntry ? { ...entry.reversedByEntry, ref: postingRef(entry.reversedByEntry), entryDate: dayText(entry.reversedByEntry.entryDate) } : null,
      people: Object.fromEntries(people.map((p) => [p.id, p.name])),
      audit,
    });
  } catch (err) {
    return acctError(err);
  }
}

/** Edit a DRAFT manual journal (date, description, lines, attachments). */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_create");
  if (error) return error;
  const { id } = await params;
  try {
    const input = parseJournalBody(await jsonBody(request));
    return NextResponse.json(await updateManualJournalDraft(id, input, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}

/** Delete a DRAFT manual journal (a posted one is never deleted — the database refuses it too). */
export async function DELETE(request: Request, { params }: Params) {
  const { user, error } = await requireSub("accounting", "journal_create");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await deleteManualJournalDraft(id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
