import { route, MktError } from "@/lib/marketing/server/http";
import { importOrdersCsv } from "@/lib/marketing/server/store";

/** A store orders export (text/csv) — declared manual import, recorded as such. */
export const POST = route(["revenue_view"], async (req, { actor }) => {
  const text = await req.text();
  if (text.length > 5_000_000) throw new MktError("الملف أكبر من 5 ميغابايت.", "File too large.", 413);
  return importOrdersCsv(text, actor);
});
