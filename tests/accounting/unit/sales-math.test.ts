// The sales editor's live totals must equal what the server stores (sales-rules computeSalesLine):
// half-up per step, for many generated quantity × price × discount × rate combinations.
// Run: npm run test:accounting:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { computeSalesLine } from "../../../src/lib/accounting/sales-rules";
import { salesLineMinor } from "../../../src/app/dashboard/accounting/_components/bill-math";

test("editor sales-line maths equals the server's for 5,000 generated lines", () => {
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const cases: [string, string, string, string][] = [["10", "120", "5", "15"], ["3", "0.335", "0", "15"], ["1", "0.005", "50", "15"], ["7", "12.3456", "12.5", "0"]];
  for (let i = 0; i < 5000; i++) cases.push([`${rnd(1000)}.${String(rnd(10000)).padStart(4, "0")}`, `${rnd(5000)}.${String(rnd(10000)).padStart(4, "0")}`, `${rnd(100)}.${String(rnd(100)).padStart(2, "0")}`, ["15", "0", "5"][rnd(3)]]);
  for (const [q, p, d, r] of cases) {
    if (Number(q) === 0) continue;
    const s = computeSalesLine(new Prisma.Decimal(q), new Prisma.Decimal(p), new Prisma.Decimal(d), new Prisma.Decimal(r));
    const c = salesLineMinor(q, p, d, r)!;
    assert.deepEqual([c.net, c.vat, c.gross], [s.net, s.vat, s.gross].map((x) => Number(x.mul(100).toFixed(0))), `${q} × ${p} − ${d}% @ ${r}%`);
  }
  assert.equal(salesLineMinor("1", "10", "100.01", "15"), null, "discount above 100% is invalid");
});
