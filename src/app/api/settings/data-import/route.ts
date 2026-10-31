import { NextResponse } from "@/lib/api-response";
import { requireDataImport, requireDataImportApply } from "@/lib/data-import/gate";
import { handleDomainError } from "@/lib/api-error";
import { auditFromRequest } from "@/lib/accounting/audit";
import { isImportEntity } from "@/lib/data-import/spec";
import { IMPORT_MAX_BYTES, SheetError, readTable } from "@/lib/data-import/sheet";
import { ImportRefused, commitImport, fileChecksum, importCounts, previewImport } from "@/lib/data-import/run";

// The opening stock rows of a large file take a while (each is a receipt with its cost-ledger entry).
export const maxDuration = 300;

/**
 * «استيراد البيانات من Excel» (Settings for the admin role; «المحاسبة» for a holder of accounting › data_import — the gate
 * is requireDataImport, src/lib/data-import/gate.ts). GET: what the system holds now. POST
 * `{ entity, fileName, fileBase64, apply? }`: without `apply` the file is checked and previewed (nothing written);
 * with `apply: true` it is imported — all or nothing, step-up (admin role or holder alike) — and a file with any error is refused with its preview.
 */
export async function GET() {
  const { error } = await requireDataImport();
  if (error) return error;
  try {
    return NextResponse.json({ counts: await importCounts() });
  } catch (err) {
    return handleDomainError(err);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireDataImport();
  if (error) return error;
  let body: { entity?: unknown; fileName?: unknown; fileBase64?: unknown; apply?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح.", errorEn: "Invalid JSON body." }, { status: 400 });
  }
  const apply = body.apply === true;
  const refused = apply ? await requireDataImportApply(user) : null;
  if (refused) return refused;
  if (!isImportEntity(body.entity)) return NextResponse.json({ error: "نوع البيانات غير معروف.", errorEn: "Unknown entity." }, { status: 400 });
  if (typeof body.fileBase64 !== "string" || !body.fileBase64) return NextResponse.json({ error: "اختر ملفًا.", errorEn: "Choose a file." }, { status: 400 });
  if (body.fileBase64.length > Math.ceil(IMPORT_MAX_BYTES / 3) * 4 + 8) return NextResponse.json({ error: "حجم الملف أكبر من 5 ميغابايت.", errorEn: "The file is larger than 5 MB." }, { status: 413 });
  const fileName = (typeof body.fileName === "string" ? body.fileName : "file").slice(0, 200);
  try {
    const buf = Buffer.from(body.fileBase64, "base64");
    const table = await readTable(buf, fileName);
    const checksum = fileChecksum(buf);
    if (!apply) return NextResponse.json({ preview: await previewImport(body.entity, table, checksum) });
    const r = await commitImport(body.entity, table, { checksum, fileName }, { id: user.id, name: user.name }, auditFromRequest(request, user.id, `data import ${body.entity}`));
    return NextResponse.json({ ...r, counts: await importCounts() }, { status: 201 });
  } catch (err) {
    if (err instanceof SheetError) return NextResponse.json({ error: err.ar, errorEn: err.en, code: "IMPORT_FILE_UNREADABLE" }, { status: 400 });
    if (err instanceof ImportRefused) return NextResponse.json({ error: "في الملف أخطاء: لم يُستورد شيء.", errorEn: err.message, code: "IMPORT_HAS_ERRORS", preview: err.preview }, { status: 422 });
    return handleDomainError(err);
  }
}
