import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAnyModule, requireEdit } from "@/lib/auth-server";
import { handleDomainError, handlePrismaError } from "@/lib/api-error";
import { emailConsentChange } from "@/lib/services/customers/email-consent";
import { canSeeCustomerContact, CUSTOMER_NAME_SELECT } from "@/lib/auth/customer-detail";
import { parseAccountFields } from "@/lib/services/customers/fields";
import { deleteCustomerFileBlobs } from "@/lib/services/customers/files";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { protectedAccountChanges } from "@/lib/services/customers/account-guard";
import { writeSettingsAudit } from "@/lib/services/settings/audit";
import { parseEmailAddress } from "@/lib/automation/email-mode";
import { customersScopedToOwner } from "@/lib/services/sales/scope";
import { forbiddenOwnerKeys, requireContactEditor } from "@/lib/services/customers/owner-contact";
import { addressFromNational, describeIdentityChanges, DUPLICATE_CUSTOMER, expandRegistrationNo, identityChanges, IDENTITY_FIELDS, NATIONAL_ADDRESS_FIELDS, parseChangeReason, parseNationalFields } from "@/lib/services/customers/customer-identity";
import { findDuplicateCustomer } from "@/lib/services/customers/duplicates";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAnyModule("customers", "orders");
  if (error) return error;

  const { id } = await params;
  // Outside a scoped rep's book reads as missing (404), never as forbidden.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const related = {
    _count: { select: { orders: true } },
    roastPreferences: {
      include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
      orderBy: { createdAt: "asc" as const },
    },
  };
  // F4 / review F-1: without the customers module, the name and roast targets only.
  const customer = canSeeCustomerContact(user.permissions)
    ? await prisma.customer.findUnique({ where: { id }, include: related })
    : await prisma.customer.findUnique({ where: { id }, select: { ...CUSTOMER_NAME_SELECT, ...related } });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(customer);
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Customers at edit, or (readiness review P1-3) the customer's account owner for its contact fields only.
  const { user, kind, error } = await requireContactEditor(id);
  if (error) return error;
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const rawBody = await request.json() as Record<string, unknown>;
    // «السجل التجاري / الرقم الموحد» is one field (owner decision, 5 Nov 2026): `registrationNo` lands in its column
    // and clears the other (a change of either needs the reason below).
    const expanded = expandRegistrationNo(rawBody ?? {});
    if (!expanded.ok) return NextResponse.json({ error: expanded.errorAr, errorEn: expanded.error, code: "INVALID_FIELD", field: expanded.field }, { status: 400 });
    const body = expanded.body as {
      name?: string; nameAr?: string; phone?: string; email?: string; address?: string;
      whatsappOptOut?: boolean; emailOptOut?: boolean;
    };
    if (kind === "owner") {
      const refused = forbiddenOwnerKeys((body ?? {}) as Record<string, unknown>);
      if (refused.length) {
        return NextResponse.json({ error: `يعدّل المندوب المسؤول بيانات التواصل، والرقم الضريبي والسجل والرقم الموحد والعنوان الوطني مع ذكر السبب — فقط (${refused.join("، ")} غير مسموح).`, errorEn: `The account owner changes the contact details, and the VAT / CR / unified number and national address with a reason — nothing else (${refused.join(", ")} refused).`, code: "FIELD_NOT_ALLOWED", fields: refused }, { status: 403 });
      }
    }
    if (body.name !== undefined && !body.name?.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    if (body.whatsappOptOut !== undefined && typeof body.whatsappOptOut !== "boolean") {
      return NextResponse.json({ error: "whatsappOptOut must be true or false" }, { status: 400 });
    }
    if (body.emailOptOut !== undefined && typeof body.emailOptOut !== "boolean") {
      return NextResponse.json({ error: "emailOptOut must be true or false" }, { status: 400 });
    }
    // The account particulars (customer account page; migration 20261019120000). Same gate as
    // the rest of this record: customers at edit. Absent keys are unchanged; "" clears one.
    const account = parseAccountFields(body as Record<string, unknown>);
    if (!account.ok) return NextResponse.json({ error: account.errorAr, errorEn: account.error }, { status: 400 });
    // Round 2 (owner decision): the unified number and the national address; a change of any «مسلّمة» needs a reason —
    // for everyone (services/customers/customer-identity.ts).
    const national = parseNationalFields(body as Record<string, unknown>);
    if (!national.ok) return NextResponse.json({ error: national.errorAr, errorEn: national.error, code: "INVALID_FIELD", field: national.field }, { status: 400 });
    const identityBefore = await prisma.customer.findUnique({ where: { id }, select: Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, true])) as Record<(typeof IDENTITY_FIELDS)[number], true> });
    const identity = identityChanges((identityBefore ?? {}) as Record<string, unknown>, { ...account.data, ...national.data } as Record<string, unknown>);
    const identityReason = parseChangeReason((body as Record<string, unknown>).reason);
    if (identity.length && !identityReason) {
      return NextResponse.json({
        error: "اكتب سبب تعديل الرقم الضريبي أو السجل أو الرقم الموحد أو العنوان الوطني (5 أحرف على الأقل).",
        errorEn: "State the reason for changing the VAT / CR / unified number or the national address (at least 5 characters).",
        code: "REASON_REQUIRED", fields: identity.map((c) => c.field),
      }, { status: 400 });
    }
    // Owner decision (5 Nov 2026): the address and city are derived from the national address — recomputed whenever
    // a national-address field changes (a legacy free address stays until then).
    const nationalMoved = identity.some((c) => (NATIONAL_ADDRESS_FIELDS as readonly string[]).includes(c.field));
    // Gate M1 (5 Nov 2026): the address only from a COMPLETE national address, the city only from a given national
    // city; otherwise the stored values (or a free value sent in this request) stay. Never cleared from an empty one.
    const derivedRaw = nationalMoved ? addressFromNational({ ...(identityBefore ?? {}), ...national.data } as Record<string, string | null>) : null;
    const derivedAddress = derivedRaw ? { ...(derivedRaw.address ? { address: derivedRaw.address } : {}), ...(derivedRaw.city ? { city: derivedRaw.city } : {}) } : null;
    // Round 3 (gate M1): a changed VAT / CR / unified number may not collide with another customer's.
    const newNumber = (f: "vatNumber" | "commercialRegNo" | "unifiedNumber") => identity.find((c) => c.field === f)?.to ?? null;
    if (newNumber("vatNumber") || newNumber("commercialRegNo") || newNumber("unifiedNumber")) {
      const dup = await findDuplicateCustomer({ vatNumber: newNumber("vatNumber"), commercialRegNo: newNumber("commercialRegNo"), unifiedNumber: newNumber("unifiedNumber") }, { excludeId: id });
      if (dup) return NextResponse.json({ ...DUPLICATE_CUSTOMER, field: dup.by }, { status: 409 });
    }
    if (account.data.accountOwnerId) {
      const owner = await prisma.employee.findFirst({ where: { id: account.data.accountOwnerId, active: true }, select: { id: true } });
      if (!owner) return NextResponse.json({ error: "المسؤول غير موجود أو غير نشط.", errorEn: "The account owner is not an active employee." }, { status: 400 });
    }

    // Who may change what decides somebody's book, commission or credit (services/customers/account-guard.ts):
    // a change to one of those fields is refused to anyone without its duty, and every change is audited
    // before / after. A value sent unchanged (the dialog posts the whole form) is not a change.
    const current = await prisma.customer.findUnique({
      where: { id },
      select: { accountOwnerId: true, creditLimit: true, paymentTermsDays: true, priceList: true, defaultHoldDays: true, reorderIntervalDays: true, email: true, emailOptOut: true, whatsappOptOut: true },
    });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Batch 25: the e-mail automated messages go to — one valid address (lower-cased), or none. Checked only when it
    // CHANGES (fix round 1): an older or imported address that fails the stricter check never blocks saving the other
    // fields; the dialog shows the error on the e-mail field only when someone edits it.
    const sentEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() || null : body.email === undefined ? undefined : null;
    const emailChanged = sentEmail !== undefined && sentEmail !== (current.email?.trim().toLowerCase() || null);
    let email: string | null = null;
    if (emailChanged && sentEmail) {
      const parsed = parseEmailAddress(sentEmail);
      if (!parsed) return NextResponse.json({ error: "اكتب إيميل واحد صحيح، مثل orders@example.com", errorEn: "Enter one valid e-mail address.", code: "INVALID_EMAIL", field: "email" }, { status: 400 });
      email = parsed;
    }
    const optOutChanged = body.emailOptOut !== undefined && body.emailOptOut !== current.emailOptOut;
    // Owner rep · manager · admin (owner decision 31 Oct 2026): a rep scoped to their own book edits the e-mail of
    // their own customers only.
    if ((emailChanged || optOutChanged) && customersScopedToOwner(user) && current.accountOwnerId !== user.id) {
      return NextResponse.json({ error: "تعديل إيميل العميل للمندوب المسؤول أو المدير.", errorEn: "Only the account owner, a manager or an admin edits the customer's e-mail.", code: "PROTECTED_ACCOUNT_FIELD" }, { status: 403 });
    }
    const guarded = protectedAccountChanges(user, current, account.data as Record<string, unknown>);
    if (!guarded.ok) return NextResponse.json({ error: guarded.errorAr, errorEn: guarded.error, code: "PROTECTED_ACCOUNT_FIELD" }, { status: 403 });

    const before = kind === "owner" || derivedAddress ? await prisma.customer.findUnique({ where: { id }, select: { phone: true, address: true, city: true } }) : null;
    const customer = await prisma.$transaction(async (tx) => {
     // «يستقبل إيميلات» goes through the one consent rule (a customer's own opt-out is turned back on by a manager with a
     // reason, from the «الرسائل» card — this form carries no reason, so such a change is refused here).
     const consent = optOutChanged ? await emailConsentChange(tx, { customerId: id, turningOn: !body.emailOptOut, actor: user, reason: null }) : null;
     const updated = await tx.customer.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.nameAr !== undefined && { nameAr: body.nameAr.trim() || null }),
        ...(body.phone !== undefined && { phone: body.phone.trim() || null }),
        ...(emailChanged && { email }),
        ...(consent ? consent.data : {}),
        ...(body.address !== undefined && { address: body.address.trim() || null }),
        ...(body.whatsappOptOut !== undefined && { whatsappOptOut: body.whatsappOptOut }),
        ...account.data,
        ...national.data,
        ...(derivedAddress ?? {}),
      },
     });
     // The address / city recomputed from the national address are logged with the change (gate M1).
     const addrNorm = (x: string | null | undefined) => (x == null || x === "" ? null : x);
     const addrChanges = derivedAddress
       ? (["address", "city"] as const).filter((k) => k in derivedAddress && addrNorm(before?.[k]) !== addrNorm(updated[k]))
           .map((k) => ({ field: k as unknown as (typeof identity)[number]["field"], from: addrNorm(before?.[k]), to: addrNorm(updated[k]) }))
       : [];
     const logged = [...identity, ...addrChanges];
     if (identity.length) {
       // The customer's «سجل النشاط» (customer page) and the audit log: who, when, why, before → after.
       await tx.activity.create({
         data: {
           type: "NOTE", customerId: id, ownerId: user.id, completedAt: new Date(), sourceKey: `customer-identity:${id}`,
           subject: "تعديل بيانات العميل الأساسية",
           body: `السبب: ${identityReason}\n${describeIdentityChanges(logged)}`,
         },
       });
       await writeSettingsAudit(tx, {
         section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed: logged.map((c) => c.field),
         before: Object.fromEntries(logged.map((c) => [c.field, c.from])), after: Object.fromEntries(logged.map((c) => [c.field, c.to])),
         reason: `CUSTOMER_IDENTITY_CHANGE: ${identityReason}`, actor: { id: user.id, name: user.name },
       });
     }
     if (kind === "owner") {
       const changed = (["phone", "address", "city"] as const).filter((k) => (body as Record<string, unknown>)[k] !== undefined).concat(emailChanged ? ["email" as never] : []);
       if (changed.length) {
         await writeSettingsAudit(tx, {
           section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed: [...changed],
           before: { phone: before?.phone ?? null, email: current.email ?? null, address: before?.address ?? null, city: before?.city ?? null },
           after: { phone: updated.phone ?? null, email: updated.email ?? null, address: updated.address ?? null, city: updated.city ?? null },
           reason: "CUSTOMER_CONTACT_BY_OWNER", actor: { id: user.id, name: user.name },
         });
       }
     }
     if (guarded.changed.length) {
       await writeSettingsAudit(tx, {
         section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id,
         changed: guarded.changed, before: guarded.before, after: guarded.after, actor: { id: user.id, name: user.name },
       });
     }
     if (emailChanged || optOutChanged) {
       await writeSettingsAudit(tx, {
         section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id,
         changed: [...(emailChanged ? ["email"] : []), ...(optOutChanged ? ["emailOptOut"] : [])],
         before: { email: current.email ?? null, emailOptOut: current.emailOptOut }, after: { email: updated.email ?? null, emailOptOut: updated.emailOptOut },
         reason: "CUSTOMER_EMAIL_SETTINGS", actor: { id: user.id, name: user.name },
       });
     }
     // Fix round 2 (council b25 seat 6 N8): a change of «يستقبل واتساب» is audited too (who, when, before / after).
     if (body.whatsappOptOut !== undefined && body.whatsappOptOut !== current.whatsappOptOut) {
       await writeSettingsAudit(tx, {
         section: "organisation", action: "SETTINGS_UPDATED", entityType: "Customer", entityId: id, changed: ["whatsappOptOut"],
         before: { whatsappOptOut: current.whatsappOptOut }, after: { whatsappOptOut: updated.whatsappOptOut },
         reason: "CUSTOMER_WHATSAPP_SETTINGS", actor: { id: user.id, name: user.name },
       });
     }
     return updated;
    });
    return NextResponse.json(customer);
  } catch (err) {
    if (err && typeof err === "object" && "_appCode" in err) return handleDomainError(err);
    return handlePrismaError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;

  const { id } = await params;
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Batch 25b (gate F1): a customer under a legal hold cannot be deleted (the database refuses too: customer_legal_hold_guard).
  const HELD = { error: "العميل عليه حجز قانوني — ما ينحذف", errorEn: "This customer is under a legal hold and cannot be deleted.", code: "LEGAL_HOLD" };
  if ((await prisma.customer.findUnique({ where: { id }, select: { messageLegalHold: true } }))?.messageLegalHold) return NextResponse.json(HELD, { status: 409 });
  try {
    // The customer's documents cascade with it; their private blobs are removed after it commits.
    const blobs = await prisma.customerFile.findMany({ where: { customerId: id, blobPathname: { not: null } }, select: { blobPathname: true } });
    await prisma.customer.delete({ where: { id } });
    await deleteCustomerFileBlobs(prisma, blobs.map((b) => b.blobPathname));
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (/CUSTOMER_LEGAL_HOLD/.test(String((err as Error)?.message ?? ""))) return NextResponse.json(HELD, { status: 409 });
    // P2003 = foreign key constraint: customer has orders
    const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : null;
    if (code === "P2003" || code === "P2014") {
      return NextResponse.json(
        { error: "Cannot delete a customer with existing orders. Archive or reassign orders first." },
        { status: 409 }
      );
    }
    return handlePrismaError(err);
  }
}
