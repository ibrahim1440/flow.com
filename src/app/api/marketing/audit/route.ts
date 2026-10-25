import { route, qp, can } from "@/lib/marketing/server/http";
import { prisma } from "@/lib/db";

// Customer phones appear as entity ids and in notes (consent, messages, webhooks): kept only for customers_data.
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const PERSONAL = new Set(["MktConsent", "MktConsentEvent", "MktMessage", "MktStoreCustomer", "MktCart", "MktJourneyEnrollment"]);

/**
 * The marketing audit trail. The whole trail is the owner's view (automation_manage — the key that already
 * governs the marketing policy and kill switches). Inside it, personal data needs customers_data and the
 * recorded before / after values (amounts, budgets, order totals) need both customers_data and revenue_view.
 */
export const GET = route("automation_manage", async (req, { actor }) => {
  const q = qp(req);
  const page = Math.max(1, Number(q.get("page")) || 1);
  const where = { ...(q.get("entityType") ? { entityType: q.get("entityType")! } : {}), ...(q.get("entityId") ? { entityId: q.get("entityId")! } : {}), ...(q.get("action") ? { action: { startsWith: q.get("action")! } } : {}) };
  const [rows, total] = await Promise.all([prisma.mktAuditLog.findMany({ where, orderBy: { at: "desc" }, skip: (page - 1) * 50, take: 50 }), prisma.mktAuditLog.count({ where })]);
  const personal = can(actor, "customers_data");
  const values = personal && can(actor, "revenue_view");
  return {
    rows: rows.map((r) => ({
      ...r,
      entityId: !personal && r.entityId && PERSONAL.has(r.entityType) ? "••••" : r.entityId,
      note: !personal && r.note ? r.note.replace(PHONE, "••••") : r.note,
      before: values ? r.before : null,
      after: values ? r.after : null,
    })),
    total, perPage: 50,
  };
});
