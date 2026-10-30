import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { customerFileHeaders, deleteCustomerFileBlobs, openCustomerFile } from "@/lib/services/customers/files";
import { editableCustomer } from "@/lib/services/customers/direct-upload";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { mayEditValidity } from "@/lib/services/customers/contracts";
import { dateText, parseValidityInput } from "@/lib/services/customers/contract-rules";
import { changedKeys, pick, writeSettingsAudit } from "@/lib/services/settings/audit";

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * GET /api/customers/[id]/files/[fileId] — the document itself, the only route that returns the
 * bytes. The file is matched against its customer in the same query (an id from another
 * customer returns nothing), and served `attachment`, `nosniff`, sandboxed and `no-store`. Bytes in
 * the row, or the private blob STREAMED through here (the browser never gets a Blob URL); a blob
 * that cannot be read is a clear Arabic 502, reported as a storage incident.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  const { id, fileId } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const row = await prisma.customerFile.findFirst({
      where: { id: fileId, customerId: id },
      select: { fileName: true, mimeType: true, sizeBytes: true, content: true, blobPathname: true },
    });
    if (!row) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    const opened = await openCustomerFile(prisma, row);
    if (!opened.ok) return NextResponse.json({ error: opened.error, errorEn: opened.errorEn, code: opened.code }, { status: opened.status });
    return new Response(opened.body, { status: 200, headers: customerFileHeaders(row) });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** DELETE /api/customers/[id]/files/[fileId] — remove a document (customers at edit; a scoped rep only on their own customer). */
export async function DELETE(_req: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id, fileId } = await params;
  try {
    // The same ownership scope as the uploads: a scoped sales rep only on a customer they own (404).
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    const row = await prisma.customerFile.findFirst({ where: { id: fileId, customerId: id }, select: { id: true, blobPathname: true } });
    const gone = row ? await prisma.customerFile.deleteMany({ where: { id: row.id, customerId: id } }) : { count: 0 };
    if (!row || gone.count === 0) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    // The blob after the row: a failed delete leaves an unreachable private blob (and an alert).
    await deleteCustomerFileBlobs(prisma, [row.blobPathname]);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * PATCH /api/customers/[id]/files/[fileId] — «صلاحية العقد» (batch 24 WP-C): change ONLY a contract's or price
 * agreement's `validFrom` / `validUntil` / `renewalNoticeDays` (absent = unchanged, null = cleared). The bytes, the
 * name, the type and the hash stay as uploaded. Who: the customer's account owner, or a sales manager / the admin
 * (mayEditValidity) — and the customer must be in the viewer's book (404 otherwise, as every customer route). Every
 * change writes a before / after row to the settings audit trail (entityType CustomerFile).
 */
export async function PATCH(request: Request, { params }: Params) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  const { id, fileId } = await params;
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const row = await prisma.customerFile.findFirst({
      where: { id: fileId, customerId: id },
      select: { id: true, category: true, title: true, validFrom: true, validUntil: true, renewalNoticeDays: true, customer: { select: { accountOwnerId: true } } },
    });
    if (!row) return NextResponse.json({ error: "الملف غير موجود.", errorEn: "Not found" }, { status: 404 });
    if (!mayEditValidity(user, row.customer)) {
      return NextResponse.json({ error: "تعديل تواريخ العقد لمسؤول العميل أو مدير المبيعات.", errorEn: "Only the customer's account owner or a sales manager may change the contract dates.", code: "NOT_OWNER" }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid request." }, { status: 400 });
    const parsed = parseValidityInput(body, row);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, errorEn: parsed.errorEn, code: parsed.code }, { status: 400 });
    const plain = (v: { validFrom: Date | null; validUntil: Date | null; renewalNoticeDays: number | null }) => ({
      validFrom: v.validFrom ? dateText(v.validFrom) : null, validUntil: v.validUntil ? dateText(v.validUntil) : null, renewalNoticeDays: v.renewalNoticeDays,
    });
    const before = plain(row);
    const after = plain(parsed.value);
    const changed = changedKeys(before, after);
    if (changed.length === 0) return NextResponse.json({ id: row.id, ...after, changed: [] });
    const saved = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerFile.update({
        where: { id: row.id },
        data: { validFrom: parsed.value.validFrom, validUntil: parsed.value.validUntil, renewalNoticeDays: parsed.value.renewalNoticeDays },
        select: { id: true, validFrom: true, validUntil: true, renewalNoticeDays: true },
      });
      await writeSettingsAudit(tx, {
        section: "organisation", action: "SETTINGS_UPDATED", entityType: "CustomerFile", entityId: row.id,
        changed, before: pick(before, changed), after: pick(after, changed), reason: `customer ${id} · ${row.title}`,
        actor: { id: user.id, name: user.name },
      });
      return updated;
    });
    return NextResponse.json({ id: saved.id, ...plain(saved), changed });
  } catch (err) {
    return handleDomainError(err);
  }
}
