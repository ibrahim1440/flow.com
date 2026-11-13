// «العملاء» in «واجهة المحاسب» (owner decision, 1 Nov 2026): the accountant sees every customer from the accounting
// side — the particulars a tax invoice carries, the balance, what is overdue, the credit limit and the rep (read only) —
// without the customers module (deals, activities, notes and the rep's book stay Sales'). They may add a customer and
// correct its invoice particulars (names, VAT, CR, city, address, phone, e-mail); never deals, notes or the rep.
//   read:  accounting module + accounting › ar;   write: the same, at edit access to accounting.
import { phoneSearchKey } from "@/lib/contact/phone";
import { prisma } from "@/lib/db";
import { canEdit, hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { parseEmailAddress } from "@/lib/automation/email-mode";
import { audit } from "@/lib/hr/core";
import { agingReport } from "@/lib/services/invoicing/ar";
import { isKsaVatNumber, normDigits } from "@/lib/services/invoicing/pricing";
import { describeIdentityChanges, expandRegistrationNo, identityChanges, parseChangeReason, parseNationalFields } from "./customer-identity";
import { findDuplicateCustomer } from "./duplicates";
import { mergeAgainst, staleRefusal } from "@/lib/http/stale-record";
import { writeSettingsAudit } from "@/lib/services/settings/audit";

export const canReadAccountingCustomers = (p: Permissions) => hasModuleAccess(p, "accounting") && hasSubPrivilege(p, "accounting", "ar");
export const canWriteAccountingCustomers = (p: Permissions) => canReadAccountingCustomers(p) && canEdit(p, "accounting");

type AppError = { _appCode: number; message: string; errorEn: string; code: string; field?: string };
const refuse = (status: number, code: string, message: string, errorEn: string, field?: string): AppError => ({ _appCode: status, code, message, errorEn, ...(field ? { field } : {}) });

export type Particulars = { name?: string; nameAr?: string | null; vatNumber?: string | null; commercialRegNo?: string | null; unifiedNumber?: string | null; city?: string | null; address?: string | null; phone?: string | null; email?: string | null };

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, max) : "");

/** The body → the columns to write, or a refusal naming the field. Pure. `create` requires the name. */
export function parseParticulars(input: Record<string, unknown>, create: boolean): Particulars {
  // «السجل التجاري / الرقم الموحد» is one field (owner decision, 5 Nov 2026): `registrationNo` lands in its column.
  const expanded = expandRegistrationNo(input);
  if (!expanded.ok) throw refuse(400, "CR_INVALID", expanded.errorAr, expanded.error, expanded.field);
  const b = expanded.body;
  const out: Particulars = {};
  if (create || "name" in b) {
    const name = clean(b.name, 200);
    if (!name) throw refuse(400, "NAME_REQUIRED", "اسم العميل مطلوب.", "The customer's name is required.", "name");
    out.name = name;
  }
  if ("nameAr" in b) out.nameAr = clean(b.nameAr, 200) || null;
  if ("vatNumber" in b) {
    const v = normDigits(b.vatNumber);
    if (v && !isKsaVatNumber(v)) throw refuse(400, "VAT_INVALID", "الرقم الضريبي 15 رقم يبدأ وينتهي بـ 3.", "A VAT number is 15 digits starting and ending with 3.", "vatNumber");
    out.vatNumber = v || null;
  }
  if ("commercialRegNo" in b) {
    const v = normDigits(b.commercialRegNo);
    if (v && !/^\d{10}$/.test(v)) throw refuse(400, "CR_INVALID", "السجل التجاري 10 أرقام.", "A commercial registration number is 10 digits.", "commercialRegNo");
    out.commercialRegNo = v || null;
  }
  // Soon batch round 3 (gate L5): the unified number (الرقم الموحد), same format as everywhere (customer-identity.ts).
  if ("unifiedNumber" in b) {
    const r = parseNationalFields({ unifiedNumber: b.unifiedNumber });
    if (!r.ok) throw refuse(400, "UNIFIED_INVALID", r.errorAr, r.error, "unifiedNumber");
    out.unifiedNumber = r.data.unifiedNumber ?? null;
  }
  if ("city" in b) out.city = clean(b.city, 80) || null;
  if ("address" in b) out.address = clean(b.address, 300) || null;
  if ("phone" in b) {
    const v = normDigits(b.phone).replace(/[^\d+]/g, "");
    if (v && !/^\+?\d{9,15}$/.test(v)) throw refuse(400, "PHONE_INVALID", "رقم الجوال غير صحيح.", "The phone number is not valid.", "phone");
    out.phone = v || null;
  }
  if ("email" in b) {
    const raw = typeof b.email === "string" ? b.email.trim() : "";
    const v = raw ? parseEmailAddress(raw) : null;
    if (raw && !v) throw refuse(400, "INVALID_EMAIL", "اكتب إيميل واحد صحيح، مثل orders@example.com", "Enter one valid e-mail address.", "email");
    out.email = v;
  }
  return out;
}

const SELECT = { id: true, name: true, nameAr: true, vatNumber: true, commercialRegNo: true, unifiedNumber: true, city: true, address: true, phone: true, email: true, creditLimit: true, paymentTermsDays: true, updatedAt: true, accountOwner: { select: { name: true } } } as const;

/** Every customer with its receivables (balance, overdue) — the accountant's list. */
export async function listAccountingCustomers(q: string | null) {
  const term = (q ?? "").trim().slice(0, 80);
  const where = term ? { OR: [{ name: { contains: term, mode: "insensitive" as const } }, { nameAr: { contains: term, mode: "insensitive" as const } }, { vatNumber: { contains: term } }, ...(phoneSearchKey(term) ? [{ phone: { contains: phoneSearchKey(term)! } }] : [])] } : {};
  const [customers, aging] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { name: "asc" }, take: 1000, select: SELECT }),
    agingReport(prisma, null),
  ]);
  const ar = new Map(aging.rows.map((r) => [r.customerId, r.aging]));
  return customers.map((c) => {
    const a = ar.get(c.id);
    return {
      id: c.id, name: c.name, nameAr: c.nameAr, vatNumber: c.vatNumber, commercialRegNo: c.commercialRegNo, unifiedNumber: c.unifiedNumber, city: c.city, address: c.address, phone: c.phone, email: c.email,
      creditLimit: c.creditLimit?.toFixed(2) ?? null, paymentTermsDays: c.paymentTermsDays, repName: c.accountOwner?.name ?? null,
      balance: a ? a.balance.toFixed(2) : "0.00", overdue: a ? a.overdue.toFixed(2) : "0.00",
      updatedAt: c.updatedAt.toISOString(), // P2 ERR-06 (gate E1): the version the edit form sends back
    };
  });
}

export async function createAccountingCustomer(body: Record<string, unknown>, actorId: string) {
  const data = parseParticulars(body, true);
  // The one duplicate check (duplicates.ts, gate M1): name / Arabic name, VAT, CR, unified number. The accountant sees
  // every customer, so the refusal may name the existing one.
  const dup = await findDuplicateCustomer({ name: data.name, nameAr: data.nameAr, vatNumber: data.vatNumber, commercialRegNo: data.commercialRegNo, unifiedNumber: data.unifiedNumber });
  if (dup) throw refuse(409, "DUPLICATE", `يوجد عميل بنفس الاسم أو الرقم الضريبي أو السجل أو الرقم الموحد: ${dup.name}.`, `A customer with the same name, VAT, CR or unified number exists: ${dup.name}.`, dup.by);
  return prisma.$transaction(async (tx) => {
    const c = await tx.customer.create({ data: { ...data, name: data.name! }, select: { id: true, name: true } });
    await audit(tx, { action: "ACCOUNTING_CUSTOMER_CREATED", entityType: "Customer", entityId: c.id, actorId, after: data });
    return c;
  });
}

/**
 * The accountant's correction. Round 3 (gate L5): a change of the VAT, CR or unified number follows the one rule
 * (customer-identity.ts) — a reason of at least 5 characters (400 REASON_REQUIRED), no collision with another
 * customer (409 DUPLICATE), and the change written on the customer's «سجل النشاط» and in the audit log
 * (SettingsAuditLog CUSTOMER_IDENTITY_CHANGE, as PUT /api/customers/[id]), besides ACCOUNTING_CUSTOMER_UPDATED.
 */
export async function updateAccountingCustomer(id: string, body: Record<string, unknown>, actor: string | { id: string; name?: string | null }) {
  const actorId = typeof actor === "string" ? actor : actor.id;
  const actorName = typeof actor === "string" ? null : actor.name ?? null;
  // P2 ERR-06 (gate E1): changed since the form opened → merged field by field; a field changed on both sides → 409.
  const stored = await prisma.customer.findUnique({ where: { id } });
  if (!stored) throw refuse(404, "NOT_FOUND", "العميل غير موجود.", "Customer not found.");
  const merged = mergeAgainst(body, { expected: body.expectedUpdatedAt, baseline: body.baseline, current: stored as unknown as Record<string, unknown> & { updatedAt: Date } });
  if (!merged.ok) throw merged.refusal;
  const data = parseParticulars(body, false);
  if (Object.keys(data).length === 0) throw refuse(400, "NOTHING", "ما فيه شي يتعدل.", "Nothing to change.");
  const current = await prisma.customer.findUnique({ where: { id }, select: { vatNumber: true, commercialRegNo: true, unifiedNumber: true } });
  if (!current) throw refuse(404, "NOT_FOUND", "العميل غير موجود.", "Customer not found.");
  const identity = identityChanges(current, data as Record<string, unknown>);
  const reason = parseChangeReason(body.reason);
  if (identity.length && !reason) {
    throw refuse(400, "REASON_REQUIRED", "اكتب سبب تعديل الرقم الضريبي أو السجل أو الرقم الموحد (5 أحرف على الأقل).", "State the reason for changing the VAT / CR / unified number (at least 5 characters).", identity[0].field);
  }
  const to = (f: string) => identity.find((c) => c.field === f)?.to ?? null;
  if (to("vatNumber") || to("commercialRegNo") || to("unifiedNumber")) {
    const dup = await findDuplicateCustomer({ vatNumber: to("vatNumber"), commercialRegNo: to("commercialRegNo"), unifiedNumber: to("unifiedNumber") }, { excludeId: id });
    if (dup) throw refuse(409, "DUPLICATE", `يوجد عميل آخر بنفس الرقم: ${dup.name}.`, `Another customer has the same number: ${dup.name}.`, dup.by);
  }
  return prisma.$transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id }, select: { name: true, nameAr: true, vatNumber: true, commercialRegNo: true, unifiedNumber: true, city: true, address: true, phone: true, email: true } });
    if (!before) throw refuse(404, "NOT_FOUND", "العميل غير موجود.", "Customer not found.");
    // Atomic (gate E1): only over the version read above.
    const w = await tx.customer.updateMany({ where: { id, updatedAt: stored.updatedAt }, data });
    if (w.count === 0) throw staleRefusal(stored.updatedAt);
    const c = await tx.customer.findUniqueOrThrow({ where: { id }, select: { id: true, name: true } });
    await audit(tx, { action: "ACCOUNTING_CUSTOMER_UPDATED", entityType: "Customer", entityId: id, actorId, before, after: data, reason: identity.length ? reason : null });
    if (identity.length) {
      await tx.activity.create({
        data: {
          type: "NOTE", customerId: id, ownerId: actorId, completedAt: new Date(), sourceKey: `customer-identity:${id}`,
          subject: "تعديل بيانات العميل الأساسية", body: `السبب: ${reason}\n${describeIdentityChanges(identity)}`,
        },
      });
      await writeSettingsAudit(tx, {
        section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed: identity.map((x) => x.field),
        before: Object.fromEntries(identity.map((x) => [x.field, x.from])), after: Object.fromEntries(identity.map((x) => [x.field, x.to])),
        reason: `CUSTOMER_IDENTITY_CHANGE: ${reason}`, actor: { id: actorId, name: actorName },
      });
    }
    return c;
  });
}
