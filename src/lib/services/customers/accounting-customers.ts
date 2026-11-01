// «العملاء» in «واجهة المحاسب» (owner decision, 1 Nov 2026): the accountant sees every customer from the accounting
// side — the particulars a tax invoice carries, the balance, what is overdue, the credit limit and the rep (read only) —
// without the customers module (deals, activities, notes and the rep's book stay Sales'). They may add a customer and
// correct its invoice particulars (names, VAT, CR, city, address, phone, e-mail); never deals, notes or the rep.
//   read:  accounting module + accounting › ar;   write: the same, at edit access to accounting.
import { prisma } from "@/lib/db";
import { canEdit, hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { parseEmailAddress } from "@/lib/automation/email-mode";
import { audit } from "@/lib/hr/core";
import { agingReport } from "@/lib/services/invoicing/ar";
import { isKsaVatNumber, normDigits } from "@/lib/services/invoicing/pricing";

export const canReadAccountingCustomers = (p: Permissions) => hasModuleAccess(p, "accounting") && hasSubPrivilege(p, "accounting", "ar");
export const canWriteAccountingCustomers = (p: Permissions) => canReadAccountingCustomers(p) && canEdit(p, "accounting");

type AppError = { _appCode: number; message: string; errorEn: string; code: string; field?: string };
const refuse = (status: number, code: string, message: string, errorEn: string, field?: string): AppError => ({ _appCode: status, code, message, errorEn, ...(field ? { field } : {}) });

export type Particulars = { name?: string; nameAr?: string | null; vatNumber?: string | null; commercialRegNo?: string | null; city?: string | null; address?: string | null; phone?: string | null; email?: string | null };

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ").slice(0, max) : "");

/** The body → the columns to write, or a refusal naming the field. Pure. `create` requires the name. */
export function parseParticulars(b: Record<string, unknown>, create: boolean): Particulars {
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

const SELECT = { id: true, name: true, nameAr: true, vatNumber: true, commercialRegNo: true, city: true, address: true, phone: true, email: true, creditLimit: true, paymentTermsDays: true, accountOwner: { select: { name: true } } } as const;

/** Every customer with its receivables (balance, overdue) — the accountant's list. */
export async function listAccountingCustomers(q: string | null) {
  const term = (q ?? "").trim().slice(0, 80);
  const where = term ? { OR: [{ name: { contains: term, mode: "insensitive" as const } }, { nameAr: { contains: term, mode: "insensitive" as const } }, { vatNumber: { contains: term } }, { phone: { contains: term } }] } : {};
  const [customers, aging] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { name: "asc" }, take: 1000, select: SELECT }),
    agingReport(prisma, null),
  ]);
  const ar = new Map(aging.rows.map((r) => [r.customerId, r.aging]));
  return customers.map((c) => {
    const a = ar.get(c.id);
    return {
      id: c.id, name: c.name, nameAr: c.nameAr, vatNumber: c.vatNumber, commercialRegNo: c.commercialRegNo, city: c.city, address: c.address, phone: c.phone, email: c.email,
      creditLimit: c.creditLimit?.toFixed(2) ?? null, paymentTermsDays: c.paymentTermsDays, repName: c.accountOwner?.name ?? null,
      balance: a ? a.balance.toFixed(2) : "0.00", overdue: a ? a.overdue.toFixed(2) : "0.00",
    };
  });
}

export async function createAccountingCustomer(body: Record<string, unknown>, actorId: string) {
  const data = parseParticulars(body, true);
  const dup = await prisma.customer.findFirst({ where: { OR: [{ name: { equals: data.name!, mode: "insensitive" } }, ...(data.vatNumber ? [{ vatNumber: data.vatNumber }] : [])] }, select: { id: true, name: true } });
  if (dup) throw refuse(409, "DUPLICATE", `يوجد عميل بنفس الاسم أو الرقم الضريبي: ${dup.name}.`, `A customer with the same name or VAT number exists: ${dup.name}.`);
  return prisma.$transaction(async (tx) => {
    const c = await tx.customer.create({ data: { ...data, name: data.name! }, select: { id: true, name: true } });
    await audit(tx, { action: "ACCOUNTING_CUSTOMER_CREATED", entityType: "Customer", entityId: c.id, actorId, after: data });
    return c;
  });
}

export async function updateAccountingCustomer(id: string, body: Record<string, unknown>, actorId: string) {
  const data = parseParticulars(body, false);
  if (Object.keys(data).length === 0) throw refuse(400, "NOTHING", "ما فيه شي يتعدل.", "Nothing to change.");
  return prisma.$transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id }, select: { name: true, nameAr: true, vatNumber: true, commercialRegNo: true, city: true, address: true, phone: true, email: true } });
    if (!before) throw refuse(404, "NOT_FOUND", "العميل غير موجود.", "Customer not found.");
    const c = await tx.customer.update({ where: { id }, data, select: { id: true, name: true } });
    await audit(tx, { action: "ACCOUNTING_CUSTOMER_UPDATED", entityType: "Customer", entityId: id, actorId, before, after: data });
    return c;
  });
}
