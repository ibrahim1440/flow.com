// «تقارير الأصول الثابتة» — read from the sub-ledger (FixedAssetEvent) only, so every figure is what the books were told:
//   register(asOf)          every asset in the books: cost, accumulated depreciation, net book value as of the day, by
//                           category; the net book value treated as deducted from the Zakat base — per asset its own
//                           flag «غير مخصوم من وعاء الزكاة», else its category's (council F4) — an indication only,
//                           labelled «تحقق مع مستشار الزكاة / zatca.gov.sa»;
//   depreciationSchedule(y) per asset, the twelve months of the year: recorded (a run / a disposal) or projected;
//   rollForward(from, to)   per category: opening, additions, carried in at go-live, disposals, depreciation, closing —
//                           cost and accumulated depreciation — and the TIE-OUT of each account to the general ledger
//                           (the register's balance vs the GL's; reconciling items: what is not in the books yet).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO } from "../money";
import { addDaysUtc, dayText } from "../dates";
import { dec, f2, FA_ROLES, scheduleOf, recordedThrough } from "./common";
import { accumulatedTarget, monthEnd } from "./schedule";

const POSTED = Prisma.sql`e."status" IN ('POSTED', 'REVERSED')`;

/** Per asset, Σ of its events up to `asOf` (inclusive) — and, given `from`, the part before it. */
async function eventSums(asOf: Date, from?: Date) {
  const rows = await prisma.$queryRaw<{ assetId: string; kind: string; opening: boolean; cost: Decimal; accum: Decimal }[]>`
    SELECT "assetId", "kind", ${from ?? null}::date IS NOT NULL AND "eventDate" < ${from ?? null}::date AS opening, sum("costDelta") AS cost, sum("accumDelta") AS accum
      FROM "FixedAssetEvent" WHERE "eventDate" <= ${asOf}::date GROUP BY 1, 2, 3`;
  return rows.map((r) => ({ ...r, cost: dec(r.cost), accum: dec(r.accum) }));
}

const categories = () => prisma.fixedAssetCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });

export async function register(asOf: Date) {
  const [assets, sums, cats] = await Promise.all([
    prisma.fixedAsset.findMany({ where: { status: { not: "DRAFT" } }, orderBy: { code: "asc" }, include: { category: { select: { id: true, nameAr: true, nameEn: true, zakatDeductible: true } }, branch: { select: { nameAr: true, nameEn: true, code: true } }, disposals: { where: { status: "POSTED" }, select: { disposalDate: true } } } }),
    eventSums(asOf), categories(),
  ]);
  const by = new Map<string, { cost: Decimal; accum: Decimal }>();
  for (const s of sums) { const x = by.get(s.assetId) ?? { cost: ZERO, accum: ZERO }; x.cost = x.cost.plus(s.cost); x.accum = x.accum.plus(s.accum); by.set(s.assetId, x); }
  const rows = assets.filter((a) => by.has(a.id)).map((a) => {
    const x = by.get(a.id) ?? { cost: ZERO, accum: ZERO };
    const disposed = a.disposals.some((d) => d.disposalDate <= asOf);
    const nbv = x.cost.minus(x.accum);
    const zakatDeductible = a.zakatDeductible ?? a.category.zakatDeductible;
    return {
      id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, category: a.category, branch: a.branch, inServiceDate: a.inServiceDate ? dayText(a.inServiceDate) : null,
      usefulLifeMonths: a.usefulLifeMonths, method: a.method, status: disposed ? "DISPOSED" : x.cost.gt(0) && !x.accum.lt(x.cost.minus(a.residualValue)) ? "FULLY_DEPRECIATED" : "ACTIVE",
      cost: x.cost.toFixed(2), accumulated: x.accum.toFixed(2), netBookValue: nbv.toFixed(2), residualValue: f2(a.residualValue), serialNumber: a.serialNumber, zakatDeductible,
    };
  });
  const totals = (list: typeof rows) => ({ count: list.length, cost: list.reduce((t, r) => t.plus(r.cost), ZERO).toFixed(2), accumulated: list.reduce((t, r) => t.plus(r.accumulated), ZERO).toFixed(2), netBookValue: list.reduce((t, r) => t.plus(r.netBookValue), ZERO).toFixed(2) });
  const live = rows.filter((r) => r.status !== "DISPOSED");
  return {
    asOf: dayText(asOf), rows,
    byCategory: cats.map((c) => ({ categoryId: c.id, nameAr: c.nameAr, nameEn: c.nameEn, zakatDeductible: c.zakatDeductible, ...totals(live.filter((r) => r.category.id === c.id)) })).filter((c) => c.count > 0),
    totals: totals(live),
    zakat: { deductibleNetBookValue: live.filter((r) => r.zakatDeductible).reduce((t, r) => t.plus(r.netBookValue), ZERO).toFixed(2),
      notDeductibleNetBookValue: live.filter((r) => !r.zakatDeductible).reduce((t, r) => t.plus(r.netBookValue), ZERO).toFixed(2),
      notDeductibleCount: live.filter((r) => !r.zakatDeductible).length,
      label: { ar: "تحقق مع مستشار الزكاة / zatca.gov.sa", en: "Check with your Zakat adviser / zatca.gov.sa" },
      note: { ar: "تقدير إرشادي: صافي القيمة الدفترية للأصول غير المعلّمة «غير مخصوم من وعاء الزكاة» — تحقق مع مستشار الزكاة / zatca.gov.sa.", en: "An indication: the net book value of the assets not marked «not deducted from the Zakat base» — check with your Zakat adviser / zatca.gov.sa." } },
  };
}

export async function depreciationSchedule(year: number) {
  const from = new Date(Date.UTC(year, 0, 1)), to = new Date(Date.UTC(year, 11, 31));
  const assets = await prisma.fixedAsset.findMany({ where: { status: { not: "DRAFT" }, inServiceDate: { lte: to } }, orderBy: { code: "asc" }, include: { category: { select: { nameAr: true, nameEn: true } } } });
  const evs = await prisma.fixedAssetEvent.findMany({ where: { kind: "DEPRECIATION", eventDate: { gte: from, lte: to } }, select: { assetId: true, eventDate: true, accumDelta: true } });
  const rec = new Map<string, Decimal[]>();
  for (const e of evs) { const m = rec.get(e.assetId) ?? Array.from({ length: 12 }, () => ZERO); m[e.eventDate.getUTCMonth()] = m[e.eventDate.getUTCMonth()].plus(e.accumDelta); rec.set(e.assetId, m); }
  const rows = assets.map((a) => {
    const months = rec.get(a.id) ?? Array.from({ length: 12 }, () => ZERO);
    const projected: boolean[] = Array.from({ length: 12 }, () => false);
    const live = (a.status === "ACTIVE") && a.basisDate;
    if (live) {
      const s = scheduleOf(a);
      const through = recordedThrough(a) as Date;
      let acc = dec(a.accumulatedDepreciation);
      for (let m = 0; m < 12; m++) {
        const end = monthEnd(new Date(Date.UTC(year, m, 1)));
        if (end <= through) continue;
        const t = accumulatedTarget(s, end);
        const c = t.minus(acc);
        if (c.gt(0)) { months[m] = months[m].plus(c); projected[m] = true; acc = t; }
      }
    }
    const total = months.reduce((t, v) => t.plus(v), ZERO);
    return { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, category: a.category, status: a.status, months: months.map((v) => v.toFixed(2)), projected, total: total.toFixed(2) };
  }).filter((r) => !dec(r.total).isZero());
  const monthTotals = Array.from({ length: 12 }, (_, m) => rows.reduce((t, r) => t.plus(r.months[m]), ZERO).toFixed(2));
  return { year, rows, monthTotals, total: rows.reduce((t, r) => t.plus(r.total), ZERO).toFixed(2) };
}

type Bucket = { opening: Decimal; additions: Decimal; carriedIn: Decimal; disposals: Decimal; depreciation: Decimal; closing: Decimal };
const bucket = (): Bucket => ({ opening: ZERO, additions: ZERO, carriedIn: ZERO, disposals: ZERO, depreciation: ZERO, closing: ZERO });
const out = (b: Bucket) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toFixed(2)])) as Record<keyof Bucket, string>;

export async function rollForward(from: Date, to: Date) {
  const [assets, cats, sums, roles, st] = await Promise.all([
    prisma.fixedAsset.findMany({ where: { status: { not: "DRAFT" } }, select: { id: true, categoryId: true } }),
    categories(), eventSums(to, from),
    prisma.accountRole.findMany({ where: { tenantId: "hiqbah", role: { in: [FA_ROLES.cost, FA_ROLES.accum] } }, select: { role: true, accountId: true } }),
    prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true, goLiveDate: true } }),
  ]);
  const catOf = new Map(assets.map((a) => [a.id, a.categoryId]));
  const per = new Map<string, { cost: Bucket; accum: Bucket }>();
  for (const s of sums) {
    const c = catOf.get(s.assetId);
    if (!c) continue;
    const x = per.get(c) ?? { cost: bucket(), accum: bucket() };
    if (s.opening) { x.cost.opening = x.cost.opening.plus(s.cost); x.accum.opening = x.accum.opening.plus(s.accum); }
    else if (s.kind === "ACQUISITION" || s.kind === "ADDITION") x.cost.additions = x.cost.additions.plus(s.cost);
    else if (s.kind === "OPENING") { x.cost.carriedIn = x.cost.carriedIn.plus(s.cost); x.accum.carriedIn = x.accum.carriedIn.plus(s.accum); }
    else if (s.kind === "DISPOSAL") { x.cost.disposals = x.cost.disposals.plus(s.cost); x.accum.disposals = x.accum.disposals.plus(s.accum); }
    else if (s.kind === "DEPRECIATION") x.accum.depreciation = x.accum.depreciation.plus(s.accum);
    x.cost.closing = x.cost.closing.plus(s.cost); x.accum.closing = x.accum.closing.plus(s.accum);
    per.set(c, x);
  }
  const rows = cats.filter((c) => per.has(c.id)).map((c) => {
    const x = per.get(c.id)!;
    return { categoryId: c.id, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, cost: out(x.cost), accumulated: out(x.accum),
      netBookValue: { opening: x.cost.opening.minus(x.accum.opening).toFixed(2), closing: x.cost.closing.minus(x.accum.closing).toFixed(2) } };
  });
  const sum = (k: "cost" | "accum") => { const t = bucket(); for (const x of per.values()) for (const f of Object.keys(t) as (keyof Bucket)[]) t[f] = t[f].plus(x[k][f]); return t; };
  const tc = sum("cost"), ta = sum("accum");

  // The tie-out: per account, the register's balance at `to` vs the general ledger's.
  const role = new Map(roles.map((r) => [r.role, r.accountId]));
  const slotAccount = (catId: string, slot: "cost" | "accum") => { const c = cats.find((x) => x.id === catId); return (slot === "cost" ? c?.costAccountId : c?.accumAccountId) ?? role.get(slot === "cost" ? FA_ROLES.cost : FA_ROLES.accum) ?? null; };
  const notPosted = await prisma.$queryRaw<{ assetId: string; cost: Decimal; accum: Decimal }[]>`
    SELECT "assetId", sum("costDelta") AS cost, sum("accumDelta") AS accum FROM "FixedAssetEvent" WHERE "eventDate" <= ${to}::date AND "glState" <> 'POSTED' GROUP BY 1`;
  const reg = new Map<string, { register: Decimal; pending: Decimal; slot: "cost" | "accum" }>();
  const add = (acc: string | null, slot: "cost" | "accum", v: Decimal, pending: Decimal) => { if (!acc) return; const x = reg.get(acc) ?? { register: ZERO, pending: ZERO, slot }; x.register = x.register.plus(v); x.pending = x.pending.plus(pending); reg.set(acc, x); };
  const pend = new Map(notPosted.map((p) => [p.assetId, p]));
  const byAsset = new Map<string, { cost: Decimal; accum: Decimal }>();
  for (const s of sums) { const x = byAsset.get(s.assetId) ?? { cost: ZERO, accum: ZERO }; x.cost = x.cost.plus(s.cost); x.accum = x.accum.plus(s.accum); byAsset.set(s.assetId, x); }
  // After the opening is posted (and `to` is on / after go-live), what was skipped / carried in is in the GL through it.
  const viaOpening = !!st?.openingEntryId && !!st.goLiveDate && to >= st.goLiveDate;
  for (const [aid, x] of byAsset) {
    const c = catOf.get(aid);
    if (!c) continue;
    const p = pend.get(aid);
    add(slotAccount(c, "cost"), "cost", x.cost, viaOpening || !p ? ZERO : dec(p.cost));
    add(slotAccount(c, "accum"), "accum", x.accum.negated(), viaOpening || !p ? ZERO : dec(p.accum).negated());
  }
  // Accounts a category or role names, even with nothing in the register (a manual posting there is a difference too).
  for (const c of cats) for (const slot of ["cost", "accum"] as const) { const a = slotAccount(c.id, slot); if (a && !reg.has(a)) reg.set(a, { register: ZERO, pending: ZERO, slot }); }
  const ids = [...reg.keys()];
  const gl = ids.length ? await prisma.$queryRaw<{ accountId: string; v: Decimal }[]>`
    SELECT l."accountId", coalesce(sum(l."debit" - l."credit"), 0) AS v FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE ${POSTED} AND l."accountId" IN (${Prisma.join(ids)}) AND e."entryDate" < ${addDaysUtc(to, 1)} GROUP BY 1` : [];
  const glOf = new Map(gl.map((g) => [g.accountId, dec(g.v)]));
  const accs = new Map((ids.length ? await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameAr: true, nameEn: true } }) : []).map((a) => [a.id, a]));
  const tieOut = [...reg.entries()].map(([id, x]) => {
    const g = glOf.get(id) ?? ZERO;
    const difference = x.register.minus(g), unexplained = difference.minus(x.pending);
    const a = accs.get(id);
    return { accountId: id, code: a?.code ?? "", name: a ? a.nameAr ?? a.nameEn : "", slot: x.slot, register: x.register.toFixed(2), gl: g.toFixed(2), difference: difference.toFixed(2), notInBooks: x.pending.toFixed(2), unexplained: unexplained.toFixed(2), status: difference.isZero() ? "MATCHED" : unexplained.isZero() ? "EXPLAINED" : "UNEXPLAINED" };
  }).sort((p, q) => p.code.localeCompare(q.code));
  return {
    from: dayText(from), to: dayText(to), rows,
    totals: { cost: out(tc), accumulated: out(ta), netBookValue: { opening: tc.opening.minus(ta.opening).toFixed(2), closing: tc.closing.minus(ta.closing).toFixed(2) } },
    tieOut, tiesToGl: tieOut.every((t) => t.status !== "UNEXPLAINED"), matched: tieOut.every((t) => t.status === "MATCHED"),
  };
}
