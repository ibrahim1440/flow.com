import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireEdit, requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import {
  CUSTOMER_FILE_SELECT, MAX_CUSTOMER_FILE_BYTES, MAX_FILES_PER_CUSTOMER, validateCustomerFile,
} from "@/lib/services/customers/files";

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
  const { error } = await requireModule("customers");
  if (error) return error;
  const { id } = await params;
  try {
    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Not found" }, { status: 404 });
    const files = await prisma.customerFile.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, select: CUSTOMER_FILE_SELECT });
    return NextResponse.json({ files, limits: { maxBytes: MAX_CUSTOMER_FILE_BYTES, maxFiles: MAX_FILES_PER_CUSTOMER, types: ["PDF", "JPEG", "PNG"] } });
  } catch (err) {
    return handleDomainError(err);
  }
}

/** POST /api/customers/[id]/files — multipart: `file`, optional `category` and `title`. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireEdit("customers");
  if (error) return error;
  const { id } = await params;
  try {
    const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true, _count: { select: { files: true } } } });
    if (!customer) return NextResponse.json({ error: "العميل غير موجود.", errorEn: "Not found" }, { status: 404 });
    if (customer._count.files >= MAX_FILES_PER_CUSTOMER) {
      return NextResponse.json({ error: `بلغ ملف العميل الحد الأقصى (${MAX_FILES_PER_CUSTOMER} ملفًا). احذف ملفًا قديمًا أولًا.`, errorEn: `The customer file holds at most ${MAX_FILES_PER_CUSTOMER} documents.`, code: "TOO_MANY_FILES" }, { status: 409 });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return NextResponse.json({ error: "أرفق ملفًا في الحقل file.", errorEn: "Attach a file in the `file` field." }, { status: 400 });
    }
    // Refused before buffering: a declared length is not proof, but an obvious oversize is cheap to refuse.
    if (file.size > MAX_CUSTOMER_FILE_BYTES) {
      return NextResponse.json({ error: "الحد الأقصى لحجم الملف 5 ميغابايت.", errorEn: "Files are limited to 5 MB.", code: "TOO_LARGE" }, { status: 413 });
    }
    const checked = validateCustomerFile(new Uint8Array(await file.arrayBuffer()), file.name, form.get("category"), form.get("title"));
    if (!checked.ok) {
      const p = checked.problem;
      return NextResponse.json({ error: p.error, errorEn: p.errorEn, code: p.code }, { status: p.status });
    }
    const v = checked.value;
    const saved = await prisma.customerFile.create({
      data: {
        customerId: id, category: v.category, title: v.title, fileName: v.fileName, mimeType: v.mimeType,
        sizeBytes: v.sizeBytes, sha256: v.sha256, content: new Uint8Array(v.content), uploadedById: user.id,
      },
      // Never the content.
      select: CUSTOMER_FILE_SELECT,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    return handleDomainError(err);
  }
}
