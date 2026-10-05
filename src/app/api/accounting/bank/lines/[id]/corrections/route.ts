import { accountingRoute, body } from "@/lib/accounting/http";
import { requestBankCorrection } from "@/lib/accounting/bank-correction-service";

export const POST = accountingRoute("bank_correction_request", async ({ user, params, request }) => requestBankCorrection(params.id, await body(request), user.id), 201);
