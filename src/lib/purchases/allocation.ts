// Batch 22 WP-J — the supplier voucher's «تخصيص تلقائي» (pure; the server re-checks every allocation).
/**
 * «تخصيص تلقائي حسب أقدمية الفواتير» (batch 22 WP-J, QOYOD-REF §8.1): the amount over the open invoices oldest first
 * (invoice date, then due date), then the opening balance. Client-side only — the server re-checks every allocation.
 */
export function allocateOldestFirst(amount: number, invoices: { id: string; invoiceDate: string; dueDate: string; outstanding: string }[], opening: number) {
  let left = Math.round(amount * 100);
  const alloc: Record<string, string> = {};
  for (const r of [...invoices].sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.dueDate.localeCompare(b.dueDate))) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(Number(r.outstanding) * 100));
    if (take > 0) { alloc[r.id] = (take / 100).toFixed(2); left -= take; }
  }
  const toOpening = Math.min(left, Math.round(opening * 100));
  return { alloc, toOpening: toOpening > 0 ? (toOpening / 100).toFixed(2) : "", unapplied: ((left - Math.max(toOpening, 0)) / 100).toFixed(2) };
}
