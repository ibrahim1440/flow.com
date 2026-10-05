import { accountingRoute, body } from "@/lib/accounting/http";
import { rejectBankCorrection } from "@/lib/accounting/bank-correction-service";

export const POST = accountingRoute("bank_correction_approve", async ({ user, params, request }) => rejectBankCorrection(params.id, user.id, (await body(request)).reason));
