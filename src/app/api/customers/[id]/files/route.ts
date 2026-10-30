import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import {
  CUSTOMER_FILE_SELECT, MAX_FILES_PER_CUSTOMER, saveCustomerFile, tooLarge, uploadLimit, validateCustomerFile,
} from "@/lib/services/customers/files";
import { directUploadOffered, editableCustomer } from "@/lib/services/customers/direct-upload";
import { customerInScope } from "@/lib/services/sales/customer-access";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/customers/[id]/files — the documents on the customer's file («الملفات», account page).
 *
 * The customer's documents are part of its record, so they take the record's gates (owner
 * policy F4, lib/auth/customer-detail): reading needs the customers module — as the contacts
 * and GET /api/customers/[id] — and changing them needs it at edit. Metadata only; the bytes
 * have their own route and headers.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  const { id } = await params;
  // A scoped sales rep reaches only the customers in their own book (services/sales/scope.ts) — 404 otherwise.
  if (!(await customerInScope(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Not found" }, { status: 404 });
    const files = await prisma.customerFile.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, select: CUSTOMER_FILE_SELECT });
    // 20 MB with the private Blob store, 5 MB in the database (services/customers/file-store.ts).
    // `direct`: files over 4 MB go from the browser straight to Blob (services/customers/direct-upload.ts).
    return NextResponse.json({ files, limits: { maxBytes: uploadLimit().maxBytes, maxFiles: MAX_FILES_PER_CUSTOMER, types: ["PDF", "JPEG", "PNG"], direct: directUploadOffered() } });
  } catch (err) {
    return handleDomainError(err);
  }
}

/**
 * POST /api/customers/[id]/files — multipart: `file`, optional `category` and `title`. Customers at
 * edit; a scoped sales rep only on a customer they own (404 otherwise). Reads stay unscoped.
 */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id } = await params;
  try {
    // Exists, and a scoped sales rep (sales without lead_assign) is its account owner — the same
    // ownership scope as the direct upload (services/customers/direct-upload.ts); otherwise 404.
    const may = await editableCustomer(prisma, user, id);
    if (!may.ok) return NextResponse.json({ error: may.problem.error, errorEn: may.problem.errorEn, code: may.problem.code }, { status: may.problem.status });
    if (may.customer.fileCount >= MAX_FILES_PER_CUSTOMER) {
      return NextResponse.json({ error: `بلغ ملف العميل الحد الأقصى (${MAX_FILES_PER_CUSTOMER} ملفًا). احذف ملفًا قديمًا أولًا.`, errorEn: `The customer file holds at most ${MAX_FILES_PER_CUSTOMER} documents.`, code: "TOO_MANY_FILES" }, { status: 409 });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return NextResponse.json({ error: "أرفق ملفًا في الحقل file.", errorEn: "Attach a file in the `file` field." }, { status: 400 });
    }
    // Refused before buffering: a declared length is not proof, but an obvious oversize is cheap to refuse.
    const { maxBytes } = uploadLimit();
    if (file.size > maxBytes) {
      const p = tooLarge(maxBytes);
      return NextResponse.json({ error: p.error, errorEn: p.errorEn, code: p.code }, { status: 413 });
    }
    const checked = validateCustomerFile(new Uint8Array(await file.arrayBuffer()), file.name, form.get("category"), form.get("title"), maxBytes);
    if (!checked.ok) {
      const p = checked.problem;
      return NextResponse.json({ error: p.error, errorEn: p.errorEn, code: p.code }, { status: p.status });
    }
    // Blob when configured (falls back to the row for ≤ 5 MB if Blob fails — and alerts); never the
    // bytes, the pathname or a Blob URL in the response.
    const saved = await saveCustomerFile(prisma, { customerId: id, uploadedById: user.id, file: checked.value });
    if (!saved.ok) {
      const p = saved.problem;
      return NextResponse.json({ error: p.error, errorEn: p.errorEn, code: p.code }, { status: p.status });
    }
    return NextResponse.json({ ...saved.row, storage: saved.storage, fallback: saved.fallback }, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
