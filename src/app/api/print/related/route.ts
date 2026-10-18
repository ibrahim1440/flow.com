import { NextResponse } from "next/server";
import { requirePrint } from "@/lib/print/server/auth";
import { PrintRefusal, relatedRecords } from "@/lib/print/server/data";

/**
 * B-7 batch / lot selector: roasting batches and finished-goods lots of ONE coffee only (the
 * coffee of the label), newest first, searchable by batch number. labels.print.
 */
export async function GET(req: Request) {
  const { error } = await requirePrint();
  if (error) return error;
  const url = new URL(req.url);
  const productId = url.searchParams.get("productId");
  if (!productId) return NextResponse.json({ error: "productId is required.", code: "PRODUCT_REQUIRED" }, { status: 400 });
  const q = url.searchParams.get("q")?.trim().slice(0, 60) || null;
  try {
    return NextResponse.json(await relatedRecords(productId, q));
  } catch (e) {
    if (e instanceof PrintRefusal) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
}
