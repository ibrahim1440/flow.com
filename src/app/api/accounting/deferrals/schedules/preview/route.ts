import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { previewSchedule } from "@/lib/accounting/deferrals";

/** The lines a schedule would get (no write). */
export async function POST(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    return NextResponse.json({ lines: await previewSchedule(await jsonBody(request)) });
  } catch (err) {
    return acctError(err);
  }
}
