// The ZATCA step after an issue committed (A4) — shared by POST /api/sales/invoices/[id]/issue and «حفظ وإصدار»
// (POST /api/sales/invoices {issue: true}). Never inside the issue transaction: a standard document is cleared now (a
// transient failure leaves it PENDING for the queue); a simplified one is reported right after the response and, failing
// that, by the queue within 24 hours.
import { after } from "next/server";
import { submitDocument, type SubmitResult } from "@/lib/zatca/pipeline";
import type { IssueResult } from "./service";

export async function zatcaAfterIssue(r: IssueResult, actorId: string): Promise<SubmitResult | { status: string; reason: string } | null> {
  if (r.zatca?.flow === "CLEARANCE") {
    return submitDocument(r.zatca.documentId, { actorId }).catch((e: { code?: string; message?: string }) => ({ status: "PENDING", reason: e?.code ?? "SUBMIT_FAILED" }));
  }
  if (r.zatca?.flow === "REPORTING") {
    const docId = r.zatca.documentId;
    after(() => submitDocument(docId, { actorId }).then(() => undefined, () => undefined));
  }
  return null;
}
