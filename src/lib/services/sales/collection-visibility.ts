// What a caller may read of a collection's money (D20 R3-L1, 10 Nov 2026). The net basis a commission is computed on, and
// the commission each approved collection produced (with the people it was paid to), are Finance's reading. A rep who
// only records sees the gross, the status and the receipt — enforced HERE, on the server, not only by hiding it on the
// page. Finance = whoever may decide a collection: commissions › collection_verify / reject / reverse, or accounting ›
// receipts_confirm (receiptAbilities).
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { receiptAbilities } from "./receipts";

export function seesCollectionNet(p: Permissions | Record<string, unknown>): boolean {
  const perms = p as Permissions;
  const rc = receiptAbilities(perms);
  return rc.confirm || rc.reject || rc.reverse || hasSubPrivilege(perms, "commissions", "collection_verify");
}

/** A collection row as a recorder may read it: no net basis, no accruals. */
export function redactCollectionRow<T extends { amountNet?: unknown; collectionEvent?: unknown }>(row: T): T {
  return { ...row, amountNet: null, collectionEvent: null };
}
