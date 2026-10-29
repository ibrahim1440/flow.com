// «فواتير بسيطة» — the request shape of a simple-invoice save: multipart/form-data with `data` (the JSON body) and `file`
// (the receipt), or a plain JSON body (an edit that keeps the receipt already attached). Read once, here.
import { opsRefuse } from "./refusals";
import type { AttachmentFile } from "./attachments";
import type { SimpleInvoiceInput } from "./simple-purchase";

export async function readSimpleRequest(request: Request): Promise<{ input: SimpleInvoiceInput; file: AttachmentFile | null }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    let form: FormData;
    try { form = await request.formData(); } catch { throw opsRefuse("OPS_BAD_INPUT", "The form could not be read.", "تعذّرت قراءة النموذج."); }
    let input: SimpleInvoiceInput;
    try { input = JSON.parse(String(form.get("data") ?? "")) as SimpleInvoiceInput; } catch { throw opsRefuse("OPS_BAD_INPUT", "data is the invoice as JSON.", "بيانات الفاتورة غير صالحة."); }
    const f = form.get("file");
    const file = f && typeof f === "object" && "arrayBuffer" in f ? { bytes: new Uint8Array(await (f as File).arrayBuffer()), fileName: (f as File).name } : null;
    return { input, file };
  }
  let body: unknown;
  try { body = await request.json(); } catch { throw opsRefuse("OPS_BAD_INPUT", "The body is not JSON.", "الطلب ليس JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw opsRefuse("OPS_BAD_INPUT");
  return { input: body as SimpleInvoiceInput, file: null };
}
