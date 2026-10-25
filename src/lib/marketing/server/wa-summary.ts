import "server-only";
import { prisma } from "@/lib/db";
import { dn } from "./http";
import { cartRecoveryRate, costPerRecovery } from "../messaging-rules";
import { sendMode } from "./whatsapp-cloud";
import { loadSettings } from "./settings";

/**
 * «لوحة قياس واتساب والسلال». Definitions (owner, section 25 — sixth):
 *   recovery rate      = eligible carts targeted that became completed orders within the attribution
 *                        window ÷ eligible carts targeted × 100. "Targeted" = at least one message SENT.
 *   cost per recovery  = messaging cost of the recovery journey ÷ recovered orders (null without cost data).
 *   attributed revenue = value of the recovering orders, cancelled excluded, refunds netted.
 * A purchase after a message is not counted unless the cart converted inside the window.
 */
export async function whatsappSummary(from: Date, to: Date, showMoney: boolean) {
  const s = await loadSettings();
  const windowMs = s.attributionWindowDays * 86_400_000;
  const [byStatus, clicks, optOuts, complaintsFailed] = await Promise.all([
    prisma.mktMessage.groupBy({ by: ["status"], where: { createdAt: { gte: from, lt: to } }, _count: { _all: true } }),
    prisma.mktTouch.count({ where: { channel: "WHATSAPP", at: { gte: from, lt: to }, detail: { path: ["kind"], equals: "click" } } }),
    prisma.mktConsentEvent.count({ where: { status: "OPTED_OUT", at: { gte: from, lt: to } } }),
    prisma.mktMessage.count({ where: { status: "FAILED", createdAt: { gte: from, lt: to } } }),
  ]);
  const n = (k: string) => byStatus.find((b) => b.status === k)?._count._all ?? 0;
  const sent = n("SENT") + n("DELIVERED") + n("READ");
  const delivered = n("DELIVERED") + n("READ");
  const read = n("READ");
  // Karzoun does not report per-message delivery / read (server/karzoun.ts): its SENT messages are left
  // out of the rates' denominators, and with nothing else to measure the rates read «غير متاح».
  const untracked = await prisma.mktMessage.count({ where: { createdAt: { gte: from, lt: to }, status: "SENT", providerId: { startsWith: "kz:" } } });
  const trackedSent = sent - untracked;
  const measurable = trackedSent > 0 || untracked === 0;

  const carts = await prisma.mktCart.findMany({ where: { abandonedAt: { gte: from, lt: to } }, select: { id: true, status: true, abandonedAt: true, convertedAt: true, convertedOrderExternalId: true, source: true } });
  const enrollments = await prisma.mktJourneyEnrollment.findMany({ where: { subjectKey: { in: carts.map((c) => `cart:${c.id}`) } }, select: { subjectKey: true, messages: { where: { status: { in: ["SENT", "DELIVERED", "READ"] } }, select: { sentAt: true, cost: true } } } });
  const targetedIds = new Set(enrollments.filter((e) => e.messages.length > 0).map((e) => e.subjectKey.slice(5)));
  const recovered = carts.filter((c) => targetedIds.has(c.id) && c.status === "CONVERTED" && c.convertedAt && c.convertedAt.getTime() - c.abandonedAt.getTime() <= windowMs);
  const orders = await prisma.mktStoreOrder.findMany({ where: { externalId: { in: recovered.map((c) => c.convertedOrderExternalId!).filter(Boolean) }, status: { not: "CANCELLED" } }, select: { total: true, refunded: true } });
  const journeyCosts = enrollments.flatMap((e) => e.messages.map((m) => m.cost));
  const costKnown = journeyCosts.length > 0 && journeyCosts.every((c) => c !== null);
  const recoveryCost = costKnown ? journeyCosts.reduce((a, c) => a + dn(c)!, 0) : null;
  const allCosts = await prisma.mktMessage.aggregate({ where: { sentAt: { gte: from, lt: to }, cost: { not: null } }, _sum: { cost: true }, _count: { _all: true } });

  const templates = await prisma.mktMessage.groupBy({ by: ["templateId", "status"], where: { createdAt: { gte: from, lt: to }, templateId: { not: null } }, _count: { _all: true } });
  const names = new Map((await prisma.mktWaTemplate.findMany({ select: { id: true, name: true } })).map((t) => [t.id, t.name]));
  const perTemplate = new Map<string, Record<string, number>>();
  for (const t of templates) {
    const r = perTemplate.get(t.templateId!) ?? {};
    r[t.status] = t._count._all;
    perTemplate.set(t.templateId!, r);
  }
  const auto = await prisma.mktMessage.count({ where: { createdAt: { gte: from, lt: to }, enrollmentId: { not: null }, status: { in: ["SENT", "DELIVERED", "READ"] } } });
  const manual = await prisma.mktMessage.count({ where: { createdAt: { gte: from, lt: to }, campaignId: { not: null }, enrollmentId: null, status: { in: ["SENT", "DELIVERED", "READ"] } } });
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);
  return {
    mode: sendMode().mode,
    window: { days: s.attributionWindowDays },
    messages: {
      scheduled: n("QUEUED"), sent, delivered: measurable ? delivered : null, read: measurable ? read : null, failed: complaintsFailed, skipped: n("SKIPPED"),
      deliveryRate: pct(delivered, trackedSent), readRate: measurable ? pct(read, delivered) : null, clicks, clickRate: measurable ? pct(clicks, delivered) : null,
      statusUnreported: untracked,
    },
    carts: { abandoned: carts.length, targeted: targetedIds.size, recovered: recovered.length, recoveryRate: cartRecoveryRate(targetedIds.size, recovered.length) },
    ...(showMoney ? {
      money: {
        recoveredValue: orders.length ? Math.round(orders.reduce((a, o) => a + dn(o.total)! - dn(o.refunded)!, 0) * 100) / 100 : recovered.length ? null : 0,
        messagingCost: allCosts._count._all ? dn(allCosts._sum.cost) : null,
        costPerRecovery: costPerRecovery(recoveryCost, recovered.length),
      },
    } : {}),
    optOuts, unsubscribeRate: pct(optOuts, sent),
    perTemplate: [...perTemplate.entries()].map(([id, st]) => ({ templateId: id, name: names.get(id) ?? id, ...st })),
    automatedVsManual: { automated: auto, manual },
  };
}
