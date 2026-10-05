import { prisma } from "@/lib/db";
import { accountingRoute, body } from "@/lib/accounting/http";
import { AccountingError } from "@/lib/accounting/errors";
import { updateDraftJournalEntry, deleteDraftJournalEntry } from "@/lib/accounting/journal-service";
import { toMinor } from "@/lib/accounting/money";
import { parseJournalBody } from "../parse";

export const GET = accountingRoute(null, async ({ params }) => {
  const e = await prisma.journalEntry.findUnique({
    where: { id: params.id },
    include: {
      lines: { include: { account: { select: { id: true, code: true, nameEn: true, nameAr: true, controlKind: true } }, branch: true, costCenter: true }, orderBy: { lineNo: "asc" } },
      fiscalPeriod: true, reversesEntry: { select: { id: true, entryNo: true } }, reversedByEntry: { select: { id: true, entryNo: true, status: true } },
      accountingEvents: { select: { id: true, eventType: true, sourceModule: true, sourceDocumentId: true, occurredAt: true } },
    },
  });
  if (!e) throw new AccountingError("Journal entry not found.", 404);
  const originEvent = e.originEventId ? await prisma.accountingEvent.findUnique({ where: { id: e.originEventId } }) : null;
  const ids = [...new Set([e.createdBy, e.submittedBy, e.approvedBy, e.postedBy, e.rejectedBy, ...e.lines.filter((l) => l.partyType === "EMPLOYEE").map((l) => l.partyId)].filter((x): x is string => !!x && !x.startsWith("system:")))];
  const names = Object.fromEntries((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  const audit = await prisma.finAuditLog.findMany({ where: { entityType: "accounting.journal", entityId: e.id }, orderBy: { createdAt: "asc" } });
  return {
    ...e,
    totalDebitMinor: toMinor(e.totalDebit), totalCreditMinor: toMinor(e.totalCredit),
    lines: e.lines.map((l) => ({ ...l, debitMinor: toMinor(l.debit), creditMinor: toMinor(l.credit), partyName: l.partyId ? names[l.partyId] ?? null : null })),
    originEvent, names, audit,
  };
});

export const PUT = accountingRoute("journal_create", async ({ user, request, params }) => updateDraftJournalEntry(params.id, parseJournalBody(await body(request)), user.id));

export const DELETE = accountingRoute("journal_create", ({ user, params }) => deleteDraftJournalEntry(params.id, user.id));
