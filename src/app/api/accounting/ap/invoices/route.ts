import { NextResponse } from "@/lib/api-response";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { requireApRead, requireDraftWriter } from "@/lib/accounting/ops/http";
import { createInvoice, listInvoices, type InvoiceInput } from "@/lib/accounting/ops/ap";
import { isSimpleMode } from "@/lib/simple-mode";
import { sodPolicy } from "@/lib/accounting/sod";

/** «فواتير الموردين» (Figma ACC-50): the list, the counts per status, what the viewer may do. */
export async function GET(request: Request) {
  const { user, error } = await requireApRead();
  if (error) return error;
  try {
    const r = await listInvoices({ status: qp(request, "status"), supplierId: qp(request, "supplierId") });
    return NextResponse.json({ ...r, viewer: { id: user.id }, simpleMode: isSimpleMode(), sodSelfAllowed: (await sodPolicy()).allowSelfApproval, can: { draft: hasSubPrivilege(user.permissions, "purchases", "invoices") || hasSubPrivilege(user.permissions, "accounting", "ap"), ap: hasSubPrivilege(user.permissions, "accounting", "ap") } });
  } catch (err) {
    return acctError(err);
  }
}

/** A new draft (Figma ACC-51). purchases › invoices or accounting › ap. */
export async function POST(request: Request) {
  const { user, error } = await requireDraftWriter();
  if (error) return error;
  try {
    return NextResponse.json(await createInvoice((await jsonBody(request)) as unknown as InvoiceInput, user.id), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
