// Smoke-render every dashboard page while a stock batch exists, plus the endpoints those
// pages call.
//
// HONEST LIMITATION: every dashboard page is a Client Component that fetches its data in an
// effect, so this only proves the server shell renders and the APIs answer 200 — it does
// NOT execute the client-side render against real rows. The actual protection against a
// page dereferencing `batch.orderItem` on a stock batch is that those local types are now
// declared nullable, so `tsc --noEmit` refuses to compile an unguarded access. This suite
// is the cheap backstop, not the guarantee. A human still has to click through the QC,
// packaging and production screens once with a stock batch present.
import { api, login, sqlOne, check, note, section, summary, BASE } from "./harness.mjs";

const PAGES = [
  "/dashboard", "/dashboard/production", "/dashboard/qc", "/dashboard/packaging",
  "/dashboard/inventory", "/dashboard/orders", "/dashboard/dispatch",
  "/dashboard/history", "/dashboard/cupping", "/dashboard/analytics",
];

async function main() {
  await login("1234");
  const stockBatches = Number(sqlOne('SELECT count(*) FROM "RoastingBatch" WHERE "orderItemId" IS NULL;'));
  section(`PAGES — every screen renders with ${stockBatches} stock batch(es) in the system`);
  check("there is at least one stock batch to trip over", stockBatches > 0, `count=${stockBatches}`);

  for (const path of PAGES) {
    const r = await api(path);
    const ok = r.status === 200 && typeof r.json === "string" && !/Application error|Internal Server Error/i.test(r.json);
    check(`renders ${path}`, ok, `status=${r.status}`);
  }

  // The API routes those pages depend on must survive a null orderItem too.
  section("APIS — the endpoints those screens call");
  for (const path of ["/api/roasting-batches", "/api/analytics", "/api/dashboard/stats",
                      "/api/export?type=production", "/api/finished-goods-lots"]) {
    const r = await api(path);
    check(`GET ${path}`, r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  note(`base = ${BASE}`);
  process.exit(summary() === 0 ? 0 : 1);
}
main().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
