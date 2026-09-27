// The bill editor's live totals must equal what the server stores: same half-up rounding per
// line, for many generated quantity × price × rate combinations. Run: npm run test:accounting:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../../src/generated/prisma/client";
import { computeLine } from "../../../src/lib/accounting/bill-rules";
import { lineMinor } from "../../../src/app/dashboard/accounting/_components/bill-math";

test("editor line maths equals the server's for 5,000 generated lines, including half-halala cases", () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const cases: [string, string, string][] = [["1", "0.005", "15"], ["3", "0.335", "15"], ["400", "28.50", "15"], ["1", "0.0333", "15"], ["7", "12.3456", "0"], ["2", "150.25", "15"]];
  for (let i = 0; i < 5000; i++) cases.push([`${rnd(1000)}.${String(rnd(10000)).padStart(4, "0")}`, `${rnd(5000)}.${String(rnd(10000)).padStart(4, "0")}`, ["15", "0", "5", "15.00"][rnd(4)]]);
  for (const [q, p, r] of cases) {
    if (Number(q) === 0 || Number(p) === 0) continue;
    const s = computeLine(new Prisma.Decimal(q), new Prisma.Decimal(p), new Prisma.Decimal(r));
    const c = lineMinor(q, p, r)!;
    assert.deepEqual([c.net, c.vat, c.gross], [s.net, s.vat, s.gross].map((d) => Math.round(Number(d.toFixed(2)) * 100)), `${q} × ${p} @ ${r}%`);
  }
  assert.equal(lineMinor("1", "abc", "15"), null);
  assert.equal(lineMinor("1.00001", "1", "15"), null, "more than four decimals is refused, as on the server");
});
