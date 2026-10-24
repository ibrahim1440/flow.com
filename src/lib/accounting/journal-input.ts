// Accounting core A1 — the manual-journal request body (create and edit share it).
import type { ManualJournalLineInput } from "./journal-service";
import { refuse } from "./refusals";
import { isBusinessDay, parseBusinessDay } from "./dates";

export function parseLines(raw: unknown): ManualJournalLineInput[] | null {
  if (!Array.isArray(raw)) return null;
  const lines: ManualJournalLineInput[] = [];
  const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { accountId, debit, credit, description, taxCategoryId, branchId, costCenterId, partyType, partyId, itemType, itemId } = item as Record<string, unknown>;
    if (typeof accountId !== "string" || !accountId) return null;
    if (typeof debit !== "number" && typeof debit !== "string") return null;
    if (typeof credit !== "number" && typeof credit !== "string") return null;
    if (description !== undefined && typeof description !== "string") return null;
    if (taxCategoryId !== undefined && typeof taxCategoryId !== "string") return null;
    if (![branchId, costCenterId, partyType, partyId, itemType, itemId].every(optStr)) return null;
    lines.push({ accountId, debit, credit, description, taxCategoryId, branchId: branchId as string | null, costCenterId: costCenterId as string | null, partyType: partyType as string | null, partyId: partyId as string | null, itemType: itemType as string | null, itemId: itemId as string | null });
  }
  return lines;
}

/** Parse the shared create / edit body (entryDate, description, lines, attachments). */
export function parseJournalBody(body: Record<string, unknown>) {
  const { entryDate, description, lines: rawLines, attachments } = body;
  if (typeof entryDate !== "string") throw refuse("BAD_INPUT", "entryDate is required (YYYY-MM-DD).");
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(entryDate) ? (isBusinessDay(entryDate) ? parseBusinessDay(entryDate) : null) : new Date(entryDate);
  if (!parsedDate || Number.isNaN(parsedDate.getTime())) throw refuse("BAD_INPUT", "entryDate must be a valid date.");
  if (description !== undefined && typeof description !== "string") throw refuse("BAD_INPUT", "description must be a string.");
  if (typeof description === "string" && description.length > 500) throw refuse("BAD_INPUT", "description is at most 500 characters.");
  const lines = parseLines(rawLines);
  if (!lines) throw refuse("BAD_INPUT", "lines must be an array of { accountId, debit, credit, description?, taxCategoryId?, branchId?, costCenterId?, partyType?, partyId?, itemType?, itemId? }.");
  return { entryDate: parsedDate, description: description as string | undefined, lines, attachments: attachments as { name: string; url: string }[] | null | undefined };
}

