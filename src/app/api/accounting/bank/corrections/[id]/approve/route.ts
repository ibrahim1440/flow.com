import { accountingRoute } from "@/lib/accounting/http";
import { approveBankCorrection } from "@/lib/accounting/bank-correction-service";

export const POST = accountingRoute("bank_correction_approve", ({ user, params }) => approveBankCorrection(params.id, user.id));
