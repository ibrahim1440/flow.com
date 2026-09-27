/**
 * The one kind of record the shell suite reads: a sales collection, so the Finance user's
 * collections screen renders its table ("Finance reaches collections…"). On the preview
 * database such records already exist; on the isolated local database this creates one
 * synthetic collection through the Sales services — a fictional customer, deal, accepted
 * quotation and submitted collection. Nothing in the spec changes.
 *
 * Refuses anything but 127.0.0.1:54329/erp_shell_local marked 'hiqbah-shell-disposable'.
 *   DATABASE_URL=<erp_shell_local owner URL> npx tsx tests/shell/local-seed.ts
 */
import { Prisma } from "../../src/generated/prisma/client";
import { prisma } from "../../src/lib/db";
import { submitCollection } from "../../src/lib/services/sales/collections";

async function main() {
  const u = new URL(process.env.DATABASE_URL ?? "");
  if (u.hostname !== "127.0.0.1" || u.port !== "54329" || u.pathname !== "/erp_shell_local") throw new Error("REFUSE: not erp_shell_local");
  const m = await prisma.$queryRawUnsafe<{ d: string | null }[]>(`SELECT shobj_description(oid,'pg_database') d FROM pg_database WHERE datname = current_database()`);
  if (m[0]?.d !== "hiqbah-shell-disposable") throw new Error("REFUSE: database not marked hiqbah-shell-disposable");

  const rep = await prisma.employee.upsert({ where: { id: "SHELL_SEED_rep" }, update: {}, create: { id: "SHELL_SEED_rep", name: "SHELL seed rep", pin: "shell-seed-no-pin", role: "custom", permissions: "{}" } });
  const stage = (await prisma.pipelineStage.findFirst({ where: { isActive: true }, orderBy: { position: "asc" } }))
    ?? await prisma.pipelineStage.create({ data: { code: "SHELL_NEW", nameEn: "New", nameAr: "جديدة", position: 1, probability: 10, isActive: true } });
  const customer = await prisma.customer.create({ data: { name: "SHELL synthetic café", nameAr: "مقهى تجريبي للاختبار" } });
  const opp = await prisma.opportunity.create({ data: { title: "SHELL synthetic deal", customerId: customer.id, stageId: stage.id, amount: "2300", currency: "SAR", probability: 50, ownerId: rep.id } });
  await prisma.quote.create({ data: { quoteNumber: "SHELL-Q-1", revision: 1, opportunityId: opp.id, customerId: customer.id, status: "ACCEPTED", currency: "SAR", subtotal: "2000", discountTotal: "0", taxTotal: "300", grandTotal: "2300", acceptedAt: new Date() } });
  const s = await prisma.$transaction((tx) => submitCollection(tx, {
    opportunityId: opp.id, amountGross: new Prisma.Decimal("2300.00"), currency: "SAR", collectedAt: new Date(),
    paymentMethod: "BANK_TRANSFER", referenceNumber: "SHELL-1", note: null, idempotencyKey: "shell-seed-1", submittedById: rep.id,
  }));
  console.log(`[shell-local] synthetic collection ${s.collectionId} (pending verification)`);
}

main().then(async () => { await prisma.$disconnect(); process.exit(0); }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
