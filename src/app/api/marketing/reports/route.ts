import { route, qp } from "@/lib/marketing/server/http";
import { buildReport, parseKind, reportRows, toCsv, toXlsx } from "@/lib/marketing/server/reports";

export const maxDuration = 60;

/** ?kind=DAILY|WEEKLY|MONTHLY&anchor=YYYY-MM-DD&format=json|csv|xlsx */
export const GET = route(undefined, async (req, { actor }) => {
  const q = qp(req);
  const kind = parseKind(q.get("kind") ?? "WEEKLY");
  const anchor = q.get("anchor") ? new Date(`${q.get("anchor")}T12:00:00+03:00`) : new Date();
  const r = await buildReport(kind, Number.isNaN(anchor.getTime()) ? new Date() : anchor, actor);
  const format = q.get("format") ?? "json";
  const name = `marketing-${kind.toLowerCase()}-${r.period.label.replace(/[^0-9-]/g, "_")}`;
  if (format === "csv") return new Response(toCsv(reportRows(r)), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
  if (format === "xlsx") return new Response(new Uint8Array(await toXlsx(r)), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}.xlsx"` } });
  return r;
});
