import { parseEmailAddress } from "@/lib/automation/email-mode";
import { phoneField } from "@/lib/contact/phone";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireAuth } from "@/lib/auth-server";
import { canEdit, hasSubPrivilege } from "@/lib/auth-shared";
import { parseAccountFields } from "@/lib/services/customers/fields";
import { addressFromNational, DUPLICATE_CUSTOMER, DUPLICATE_CUSTOMER_OWN, expandRegistrationNo, parseNationalFields } from "@/lib/services/customers/customer-identity";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { findDuplicateCustomer } from "@/lib/services/customers/duplicates";
import { handlePrismaError } from "@/lib/api-error";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";
import { customerVisibilityWhere, customersScopedToOwner } from "@/lib/services/sales/scope";

export async function GET(request?: Request) {
  const { user, error } = await requireAnyModule("customers", "orders");
  if (error) return error;

  const related = {
    _count: { select: { orders: true, roastPreferences: true } },
    roastPreferences: {
      include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
      orderBy: { createdAt: "asc" as const },
    },
  };
  // A scoped sales rep lists their own book only (services/sales/scope.ts); everyone else as before.
  // `?owner=me` («عملائي», batch 24): only narrows what the viewer may already see to the customers whose account
  // owner they are (`accountOwnerId = me`, the batch's one definition, as Ctrl K) — it can never widen anything.
  const mine = request ? new URL(request.url).searchParams.get("owner") === "me" : false;
  const visible = customerVisibilityWhere(user);
  const where = mine ? { AND: [visible, { accountOwnerId: user.id }] } : visible;
  // F4 / review F-1: orders:view alone (production, dispatch) lists customers by name for the
  // order screens; the contact record (phone, email, address, opt-out) is the customers module's.
  const customers = canSeeCustomerContact(user.permissions)
    ? await prisma.customer.findMany({ where, orderBy: { name: "asc" }, take: 200, include: related })
    : await prisma.customer.findMany({ where, orderBy: { name: "asc" }, take: 200, select: { ...CUSTOMER_NAME_SELECT, ...related } });
  return NextResponse.json(customers);
}

/**
 * «عميل جديد». Customers › edit as before; and (soon batch round 2, owner decision) a sales rep holding lead_write or
 * lead_convert registers a customer of their own — the account owner is always the rep. Round 4 (owner decision): the
 * NAME is the only required field, for everyone — a startup or a family business may have no VAT or CR yet; phone,
 * e-mail, city, address, VAT, CR / unified number and the national address are optional. A value given is checked
 * (VAT, CR, unified number, postal code, building and additional numbers); an empty one is stored as NULL. The
 * duplicate check runs on the non-empty values only.
 */
export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const fullEditor = canEdit(user.permissions, "customers");
  const repRegistration = !fullEditor && (hasSubPrivilege(user.permissions, "sales", "lead_write") || hasSubPrivilege(user.permissions, "sales", "lead_convert"));
  if (!fullEditor && !repRegistration) return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });

  try {
    const raw = await request.json() as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    // «السجل التجاري / الرقم الموحد» is one field (owner decision, 5 Nov 2026): `registrationNo` lands in its column.
    const expanded = expandRegistrationNo(raw as Record<string, unknown>);
    if (!expanded.ok) return NextResponse.json({ error: expanded.errorAr, errorEn: expanded.error, code: "INVALID_FIELD", field: expanded.field }, { status: 400 });
    const body = expanded.body as {
      name: string; nameAr?: string; phone?: string; email?: string; address?: string;
      whatsappOptOut?: boolean;
    } & Record<string, unknown>;
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "اسم العميل مطلوب.", errorEn: "name is required", code: "NAME_REQUIRED", field: "name" }, { status: 400 });
    }
    // Batch 25: one valid address (lower-cased) or none — automated e-mails go to it.
    const email = typeof body.email === "string" && body.email.trim() ? parseEmailAddress(body.email) : null;
    if (typeof body.email === "string" && body.email.trim() && !email) {
      return NextResponse.json({ error: "اكتب إيميل واحد صحيح، مثل orders@example.com", errorEn: "Enter one valid e-mail address.", code: "INVALID_EMAIL", field: "email" }, { status: 400 });
    }
    // The registration particulars a creator may give (the rest of the account — credit, terms, owner — is the
    // customers editors' own, on the account page).
    const identityInput = Object.fromEntries(["vatNumber", "commercialRegNo", "city"].filter((k) => k in body).map((k) => [k, body[k]]));
    const account = parseAccountFields(identityInput);
    if (!account.ok) return NextResponse.json({ error: account.errorAr, errorEn: account.error, code: "INVALID_FIELD" }, { status: 400 });
    const national = parseNationalFields(body);
    if (!national.ok) return NextResponse.json({ error: national.errorAr, errorEn: national.error, code: "INVALID_FIELD", field: national.field }, { status: 400 });
    // Round 3 (gate M1): no copy of an existing customer — the pool's and other reps' included — on the VAT, CR or
    // unified number, or the exact normalised name. A rep is never told whose it is.
    const dup = await findDuplicateCustomer({
      name: body.name, nameAr: typeof body.nameAr === "string" ? body.nameAr : null,
      vatNumber: account.data.vatNumber ?? null, commercialRegNo: account.data.commercialRegNo ?? null, unifiedNumber: national.data.unifiedNumber ?? null,
    });
    if (dup) {
      // P1 ERR-08: in the caller's own book — named, to open it; anyone else's stays unnamed (SEC-06).
      if (await customerInScope(user, dup.id)) return NextResponse.json({ ...DUPLICATE_CUSTOMER_OWN, field: dup.by, customer: { id: dup.id, name: dup.name } }, { status: 409 });
      return NextResponse.json({ ...DUPLICATE_CUSTOMER, field: dup.by }, { status: 409 });
    }

    // P1 ERR-04: the shared reader — stored canonical (+966…), or a coded Arabic 400 on the phone field.
    let phone: string | null;
    try { phone = phoneField(body.phone) ?? null; } catch (e) { const x = e as { message: string; errorEn: string; code: string }; return NextResponse.json({ error: x.message, errorEn: x.errorEn, code: x.code, field: "phone" }, { status: 400 }); }
    const fromNational = addressFromNational(national.data);
    const freeAddress = typeof body.address === "string" ? body.address.trim() || null : null;
    const derived = { address: freeAddress ?? fromNational.address, city: account.data.city ?? fromNational.city };

    const customer = await prisma.customer.create({
      data: {
        name: body.name.trim(),
        nameAr: typeof body.nameAr === "string" ? body.nameAr.trim() || null : null,
        phone,
        email,
        whatsappOptOut: body.whatsappOptOut === true,
        ...account.data,
        ...national.data,
        // Owner decision (5 Nov 2026): the form no longer asks for a free address or city — the national address is
        // the customer's address, and the address / city everything else reads (delivery, print, invoice, Qoyod) are
        // derived from it. A caller that still sends them (import, API) keeps its own.
        ...derived,
        // Owner decision (3 Nov 2026): a rep's book no longer includes the unassigned pool, so a customer a scoped rep
        // adds is theirs from the start (as a converted lead is) — it must not vanish from their own list. A rep
        // registering without customers › edit is always the account owner.
        ...(repRegistration || customersScopedToOwner(user) ? { accountOwnerId: user.id } : {}),
      },
    });
    return NextResponse.json(customer, { status: 201 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
