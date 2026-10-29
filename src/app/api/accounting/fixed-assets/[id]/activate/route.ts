import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaWrite } from "@/lib/accounting/fixed-assets/http";
import { activateAsset } from "@/lib/accounting/fixed-assets/assets";

type Params = { params: Promise<{ id: string }> };

/** «تفعيل الأصل»: the acquisition is recorded (and posted when the books are on). Step-up. */
export async function POST(request: Request, { params }: Params) {
  const { user, error } = await requireFaWrite({ duty: "journal_post" });
  if (error) return error;
  try {
    return NextResponse.json(await activateAsset((await params).id, auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
