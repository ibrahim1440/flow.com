// «إسناد العملاء لمندوب» (owner request, 2 Nov 2026): the general manager or the admin assigns several customers to one
// sales rep at once (or unassigns them). The SAME rule and audit as the single change on the customer's details dialog
// (PUT /api/customers/[id] → protectedAccountChanges / writeSettingsAudit): `mayChangeAccountOwner` decides, and every
// customer whose owner changes gets its own before / after row. One transaction; the new rep is told once.
import type { Prisma } from "@/generated/prisma/client";
import { notify } from "@/lib/notifications/notify";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { mayChangeAccountOwner } from "./account-guard";

type Tx = Prisma.TransactionClient;
type Viewer = { id: string; name?: string | null; role?: string | null; permissions: Record<string, unknown> };
type AppError = { _appCode: number; message: string; errorEn: string; code: string };
const refuse = (status: number, code: string, message: string, errorEn: string): AppError => ({ _appCode: status, code, message, errorEn });

export const ASSIGN_MAX = 500;

/** The body, validated: 1..500 distinct ids and an owner id or null. */
export function parseAssignBody(raw: unknown): { ok: true; customerIds: string[]; ownerId: string | null } | { ok: false; error: AppError } {
  const b = (raw && typeof raw === "object" ? raw : {}) as { customerIds?: unknown; ownerId?: unknown };
  if (!Array.isArray(b.customerIds) || b.customerIds.length === 0) return { ok: false, error: refuse(400, "NO_CUSTOMERS", "اختر عميلًا واحدًا على الأقل.", "Choose at least one customer.") };
  const ids = [...new Set(b.customerIds.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  if (ids.length !== new Set(b.customerIds).size) return { ok: false, error: refuse(400, "BAD_IDS", "معرّف عميل غير صالح.", "An invalid customer id.") };
  if (ids.length > ASSIGN_MAX) return { ok: false, error: refuse(400, "TOO_MANY", `حتى ${ASSIGN_MAX} عميل في المرة.`, `At most ${ASSIGN_MAX} customers at once.`) };
  if (b.ownerId !== null && (typeof b.ownerId !== "string" || !b.ownerId)) return { ok: false, error: refuse(400, "BAD_OWNER", "اختر المندوب.", "Choose the rep.") };
  return { ok: true, customerIds: ids, ownerId: b.ownerId as string | null };
}

export async function assignCustomersOwner(tx: Tx, user: Viewer, raw: unknown) {
  if (!mayChangeAccountOwner(user)) throw refuse(403, "PROTECTED_ACCOUNT_FIELD", "تغيير المسؤول عن الحساب لمدير المبيعات أو مدير العمولات أو المدير فقط.", "Only a sales manager, a commission manager or the administrator changes the account owner.");
  const p = parseAssignBody(raw);
  if (!p.ok) throw p.error;
  let ownerName: string | null = null;
  if (p.ownerId) {
    const owner = await tx.employee.findFirst({ where: { id: p.ownerId, active: true }, select: { id: true, name: true } });
    if (!owner) throw refuse(400, "OWNER_INACTIVE", "المسؤول غير موجود أو غير نشط.", "The account owner is not an active employee.");
    ownerName = owner.name;
  }
  const rows = await tx.customer.findMany({ where: { id: { in: p.customerIds } }, select: { id: true, accountOwnerId: true } });
  const found = new Set(rows.map((r) => r.id));
  const notFound = p.customerIds.filter((id) => !found.has(id));
  const toChange = rows.filter((r) => (r.accountOwnerId ?? null) !== p.ownerId);
  const unchanged = rows.filter((r) => (r.accountOwnerId ?? null) === p.ownerId).map((r) => r.id);
  for (const r of toChange) {
    await tx.customer.update({ where: { id: r.id }, data: { accountOwnerId: p.ownerId } });
    await writeSettingsAudit(tx, {
      section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: r.id, changed: ["accountOwnerId"],
      before: { accountOwnerId: r.accountOwnerId ?? null }, after: { accountOwnerId: p.ownerId }, reason: "CUSTOMERS_BULK_ASSIGN",
      actor: { id: user.id, name: user.name ?? null },
    });
  }
  if (p.ownerId && toChange.length) {
    await notify(tx, {
      event: "sales.customers_assigned", dedupeKey: `${p.ownerId}:${Date.now()}`, actorId: user.id,
      people: { recipient: p.ownerId },
      facts: { count: toChange.length, actorName: user.name ?? "" },
    });
  }
  return { changed: toChange.map((r) => r.id), unchanged, notFound, ownerId: p.ownerId, ownerName };
}
