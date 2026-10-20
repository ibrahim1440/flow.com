import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { canEdit, hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { seesAllSales, collectionWhere, NOT_FOUND_MESSAGE } from "@/lib/services/sales/scope";
import {
  Decimal, acceptedDocumentPerDeal, monthlyQuantities, orderRhythm, outstandingBalance,
  salesLast12Months, usualItems, type OrderRow,
} from "@/lib/services/customers/aggregates";
import { deliveryLotsFor } from "@/lib/services/delivery-lots";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/customers/[id]/account — everything the customer account page draws
 * (Figma crm-account 179:1312 / 390 178:1353), in one request.
 *
 * ── Who may read what ──
 * The account is the customer's contact record, so the gate is the customers module — the
 * same module that GET /api/customers/[id] requires for the contact fields (owner policy F4:
 * holding orders alone gives the name, never the contact record). Each section then needs
 * the module that owns its data, exactly as that module's own endpoints do:
 *   orders, order figures, VAT-invoice states  — the orders module (GET /api/orders);
 *   deals, quotations, samples, activities,
 *   sales and balance figures, lead source     — the sales module, scoped as every sales
 *                                                endpoint is: a rep sees the deals they own
 *                                                (services/sales/scope.ts), seeing everyone's
 *                                                is `lead_assign`;
 *   collections (payments)                      — the sales module, rows scoped by
 *                                                `collectionWhere` like /api/sales/collections.
 * A section the caller may not read comes back as null — not as zero — so the page can say
 * «لا تملك صلاحية» instead of showing a figure that is not the customer's.
 * SIMPLE_MODE needs nothing here: it is applied to the session's permissions upstream
 * (simpleModePermissions), as for every other route.
 */
export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireModule("customers");
  if (error) return error;
  const { id } = await params;
  const p = user.permissions;
  const sales = hasModuleAccess(p, "sales");
  const orders = hasModuleAccess(p, "orders");
  const all = sales && seesAllSales(p);
  const dealScope = all ? {} : { ownerId: user.id };
  const now = new Date();

  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: {
        id: true, name: true, nameAr: true, phone: true, email: true, address: true,
        whatsappOptOut: true, createdAt: true,
        commercialRegNo: true, vatNumber: true, segment: true, city: true, priceList: true,
        paymentTermsDays: true, creditLimit: true,
        accountOwner: { select: { id: true, name: true } },
        contacts: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, role: true, phone: true, email: true, position: true } },
        roastPreferences: {
          orderBy: { createdAt: "asc" },
          include: { greenBean: { select: { id: true, beanType: true, serialNumber: true } } },
        },
        _count: { select: { orders: true, roastPreferences: true } },
      },
    });
    if (!customer) return NextResponse.json({ error: NOT_FOUND_MESSAGE }, { status: 404 });

    // ── Orders (orders module) ──────────────────────────────────────────────────────────
    const orderRows = orders
      ? await prisma.order.findMany({
          where: { customerId: id },
          orderBy: { createdAt: "desc" },
          take: 500,
          select: {
            id: true, orderNumber: true, createdAt: true, status: true, approvalStatus: true,
            paymentStatus: true, vatInvoiceStatus: true, quotationNumber: true,
            items: {
              select: {
                quantityKg: true, quantityUnits: true, beanTypeName: true,
                productSku: { select: { name: true, skuCode: true } },
                product: { select: { productNameEn: true, productNameAr: true } },
              },
            },
            opportunityLinks: { select: { quoteId: true, opportunityId: true, quote: { select: { grandTotal: true, _count: { select: { orderLinks: true } } } } } },
          },
        })
      : null;
    const asRows: OrderRow[] = (orderRows ?? []).map((o) => ({
      id: o.id, orderNumber: o.orderNumber, createdAt: o.createdAt, status: o.status,
      items: o.items.map((i) => ({ quantityKg: i.quantityKg, name: i.productSku?.name ?? i.product?.productNameAr ?? i.product?.productNameEn ?? i.beanTypeName })),
    }));

    // ── Sales (sales module, owner-scoped) ─────────────────────────────────────────────
    const dealsP = sales
      ? prisma.opportunity.findMany({
          where: { customerId: id, ...dealScope },
          orderBy: [{ outcome: "asc" }, { updatedAt: "desc" }],
          take: 200,
          select: {
            id: true, title: true, outcome: true, amount: true, currency: true, probability: true,
            expectedCloseAt: true, nextFollowUpAt: true, createdAt: true, updatedAt: true, closedAt: true, lostReason: true,
            stage: { select: { id: true, code: true, nameEn: true, nameAr: true, position: true } },
            owner: { select: { id: true, name: true } },
            stageEvents: { orderBy: { createdAt: "desc" }, take: 50, select: { id: true, fromStageId: true, toStageId: true, createdAt: true } },
            _count: { select: { quotes: true, samples: true } },
          },
        })
      : Promise.resolve(null);
    const quotesP = sales
      ? prisma.quote.findMany({
          where: { opportunity: { customerId: id, ...dealScope } },
          orderBy: [{ createdAt: "desc" }],
          take: 200,
          select: {
            id: true, quoteNumber: true, revision: true, status: true, currency: true, validUntil: true,
            grandTotal: true, taxTotal: true, issuedAt: true, acceptedAt: true, createdAt: true, opportunityId: true,
            opportunity: { select: { id: true, title: true } },
          },
        })
      : Promise.resolve(null);
    const samplesP = sales
      ? prisma.sampleShipment.findMany({
          where: { opportunity: { customerId: id, ...dealScope } },
          orderBy: { createdAt: "desc" },
          take: 200,
          select: {
            id: true, description: true, quantity: true, unit: true, status: true, sentAt: true,
            feedbackScore: true, createdAt: true,
            productSku: { select: { name: true, skuCode: true } },
            opportunity: { select: { id: true, title: true } },
          },
        })
      : Promise.resolve(null);
    // Activities: those on the customer itself and those on its deals. Scoped like the
    // follow-up list (/api/sales/activities): your own unless you see the team's.
    const activitiesP = sales
      ? prisma.activity.findMany({
          where: {
            OR: [{ customerId: id }, { opportunity: { customerId: id } }],
            ...(all ? {} : { ownerId: user.id }),
          },
          orderBy: [{ createdAt: "desc" }],
          take: 200,
          select: {
            id: true, type: true, subject: true, body: true, outcome: true, dueAt: true, completedAt: true, createdAt: true,
            owner: { select: { id: true, name: true } },
            opportunity: { select: { id: true, title: true } },
          },
        })
      : Promise.resolve(null);
    // Collections listed: what /api/sales/collections would list this caller, for this customer.
    const collectionsP = sales
      ? prisma.salesCollection.findMany({
          where: { OR: [{ customerId: id }, { opportunity: { customerId: id } }], ...collectionWhere(p, user.id) },
          orderBy: { collectedAt: "desc" },
          take: 200,
          select: {
            id: true, status: true, amountGross: true, currency: true, paymentMethod: true, collectedAt: true,
            referenceNumber: true, opportunityId: true,
            order: { select: { id: true, orderNumber: true } },
            opportunity: { select: { id: true, title: true } },
          },
        })
      : Promise.resolve(null);
    const sourceP = sales
      ? prisma.leadConversion.findFirst({
          where: { customerId: id },
          orderBy: { convertedAt: "asc" },
          select: { leadId: true, convertedAt: true, lead: { select: { source: true, sourceNote: true } } },
        })
      : Promise.resolve(null);
    // Every stage, hidden ones included: the history names the stages a deal passed through,
    // and a stage hidden later (only open deals block hiding) must still resolve its label.
    // The page draws the stage track from the active ones (`isActive`).
    const stagesP = sales
      ? prisma.pipelineStage.findMany({
          orderBy: { position: "asc" },
          select: { id: true, code: true, nameEn: true, nameAr: true, position: true, isActive: true },
        })
      : Promise.resolve(null);

    const [deals, quotes, samples, activityRows, collections, source, stages] =
      await Promise.all([dealsP, quotesP, samplesP, activitiesP, collectionsP, sourceP, stagesP]);
    // `mine`: only the person who logged an activity may complete it (PATCH /api/sales/activities/[id]).
    const activities = activityRows?.map((a) => ({ ...a, mine: a.owner.id === user.id })) ?? null;

    // ── Money (sales module): accepted documents of the deals in scope, and the APPROVED
    //    collections against those deals — all of them, whoever recorded them, exactly as the
    //    deal page's collectionSummary counts them. ──
    let salesFigure = null, balance = null;
    if (sales && deals && quotes) {
      const dealIds = deals.map((d) => d.id);
      const accepted = acceptedDocumentPerDeal(quotes.filter((q) => q.status === "ACCEPTED"));
      const approved = dealIds.length
        ? await prisma.salesCollection.findMany({
            where: { opportunityId: { in: dealIds }, status: "APPROVED" },
            select: { opportunityId: true, amountGross: true, collectedAt: true, paymentMethod: true, order: { select: { orderNumber: true } } },
            orderBy: { collectedAt: "desc" },
          })
        : [];
      const s = salesLast12Months(accepted.map((q) => ({
        opportunityId: q.opportunityId, quoteId: q.id, quoteNumber: q.quoteNumber, acceptedAt: q.acceptedAt,
        grandTotal: new Decimal(q.grandTotal.toString()), taxTotal: new Decimal(q.taxTotal.toString()),
      })), now);
      const b = outstandingBalance(
        accepted.map((q) => ({ opportunityId: q.opportunityId, grandTotal: new Decimal(q.grandTotal.toString()) })),
        approved.map((c) => ({ opportunityId: c.opportunityId, amountGross: new Decimal(c.amountGross.toString()) })),
      );
      salesFigure = { net: s.net.toFixed(2), previousNet: s.previousNet.toFixed(2), changePercent: s.changePercent, documents: s.documents, currency: "SAR" };
      const last = approved[0];
      balance = {
        outstanding: b.outstanding.toFixed(2), documents: b.documents, openDocuments: b.openDocuments, currency: "SAR",
        lastPayment: last ? { amount: last.amountGross.toFixed(2), collectedAt: last.collectedAt, method: last.paymentMethod, orderNumber: last.order?.orderNumber ?? null } : null,
      };
    }

    const rhythm = orders ? orderRhythm(asRows, now) : null;

    // ── The open deal of the overview: the open deal in scope moved most recently. ──
    const openDeals = (deals ?? []).filter((d) => d.outcome === "OPEN");
    const primary = openDeals[0] ?? null;
    const dealActivities = primary ? (activities ?? []).filter((a) => a.opportunity?.id === primary.id) : [];
    const nextStep = [...dealActivities, ...(activities ?? []).filter((a) => !a.opportunity)]
      .filter((a) => !a.completedAt)
      .sort((a, b) => (a.dueAt ? a.dueAt.getTime() : Infinity) - (b.dueAt ? b.dueAt.getTime() : Infinity))[0] ?? null;

    // ── The timeline: what happened with this customer, newest first. Built here so every
    //    entry is already scoped; the page only words it. ──
    type Entry = { key: string; at: Date; kind: string; [k: string]: unknown };
    const timeline: Entry[] = [];
    for (const a of activities ?? []) {
      timeline.push({ key: `a-${a.id}`, at: a.completedAt ?? a.createdAt, kind: "activity", activity: a });
    }
    for (const s of samples ?? []) {
      if (s.sentAt) timeline.push({ key: `s-${s.id}`, at: s.sentAt, kind: "sample", sample: { id: s.id, name: s.productSku?.name ?? s.productSku?.skuCode ?? s.description, quantity: s.quantity.toString(), unit: s.unit, deal: s.opportunity } });
    }
    const stageMoves = (deals ?? []).flatMap((d) => d.stageEvents.filter((e) => e.fromStageId && e.toStageId).map((e) => ({ ...e, used: false })));
    for (const q of quotes ?? []) {
      if (q.issuedAt) {
        const t = q.issuedAt.getTime();
        const move = stageMoves.find((m) => !m.used && Math.abs(m.createdAt.getTime() - t) < 120_000);
        if (move) move.used = true;
        timeline.push({ key: `qi-${q.id}`, at: q.issuedAt, kind: "quote_issued", quote: { id: q.id, quoteNumber: q.quoteNumber, revision: q.revision, grandTotal: q.grandTotal.toFixed(2), currency: q.currency }, stageMove: move ? { from: move.fromStageId, to: move.toStageId } : null });
      }
      if (q.acceptedAt) timeline.push({ key: `qa-${q.id}`, at: q.acceptedAt, kind: "quote_accepted", quote: { id: q.id, quoteNumber: q.quoteNumber, revision: q.revision, grandTotal: q.grandTotal.toFixed(2), currency: q.currency } });
    }
    for (const o of orderRows ?? []) {
      const totalKg = Math.round(o.items.reduce((s, i) => s + i.quantityKg, 0) * 100) / 100;
      // A value only where one exists: the accepted quotation the order was made from, and only
      // when that quotation produced this one order (a repeat order would otherwise show the
      // whole quotation's value again).
      const link = o.opportunityLinks.find((l) => l.quote && l.quote._count.orderLinks === 1);
      timeline.push({ key: `o-${o.id}`, at: o.createdAt, kind: "order", order: { id: o.id, orderNumber: o.orderNumber, totalKg, status: o.status, value: link?.quote ? link.quote.grandTotal.toFixed(2) : null } });
    }
    // Deliveries (orders module, Phase D): what left the shelf for this customer and from which
    // lots — DeliveryLine rows, or the ledger lot of a delivery recorded before them.
    if (orders) {
      const dels = await prisma.delivery.findMany({
        where: { orderItem: { order: { customerId: id } } },
        orderBy: { date: "desc" },
        take: 200,
        select: {
          id: true, date: true, quantityUnits: true, quantityKg: true, deliveryType: true,
          orderItem: { select: { beanTypeName: true, productSku: { select: { name: true, skuCode: true } }, order: { select: { orderNumber: true } } } },
        },
      });
      const lotsBy = await deliveryLotsFor(prisma, dels.map((d) => d.id));
      for (const d of dels) {
        timeline.push({ key: `d-${d.id}`, at: d.date, kind: "delivery", delivery: {
          id: d.id, orderNumber: d.orderItem.order.orderNumber,
          item: d.orderItem.productSku?.name ?? d.orderItem.productSku?.skuCode ?? d.orderItem.beanTypeName,
          units: d.quantityUnits, kg: d.quantityKg, type: d.deliveryType,
          lots: (lotsBy.get(d.id) ?? []).map((x) => x.batchNumber ?? "—"),
        } });
      }
    }
    for (const c of collections ?? []) {
      if (c.status !== "APPROVED") continue;
      timeline.push({ key: `c-${c.id}`, at: c.collectedAt, kind: "payment", payment: { id: c.id, amount: c.amountGross.toFixed(2), currency: c.currency, method: c.paymentMethod, orderNumber: c.order?.orderNumber ?? null } });
    }
    timeline.sort((a, b) => b.at.getTime() - a.at.getTime());

    return NextResponse.json({
      customer: { ...customer, creditLimit: customer.creditLimit?.toFixed(2) ?? null },
      source: source ? { leadId: source.leadId, convertedAt: source.convertedAt, source: source.lead.source, sourceNote: source.lead.sourceNote } : null,
      sections: { sales, orders, scope: sales ? (all ? "all" : "own") : null, files: false },
      metrics: {
        sales12m: salesFigure,
        balance,
        lastOrder: rhythm?.lastOrder ?? null,
        cadenceDays: rhythm?.cadenceDays ?? null,
        monthly: orders ? monthlyQuantities(asRows, now) : null,
        usualItems: orders ? usualItems(asRows, now) : null,
        unpricedOrders: orders && orderRows ? orderRows.filter((o) => o.opportunityLinks.length === 0).length : null,
      },
      openDeal: primary ? {
        ...primary, amount: primary.amount.toFixed(2), stageEvents: primary.stageEvents,
        nextStep: nextStep && nextStep.opportunity?.id === primary.id ? nextStep : null,
      } : null,
      nextStep,
      openDeals: openDeals.length,
      stages,
      deals: deals?.map((d) => ({
        id: d.id, title: d.title, outcome: d.outcome, amount: d.amount.toFixed(2), currency: d.currency, probability: d.probability,
        expectedCloseAt: d.expectedCloseAt, createdAt: d.createdAt, closedAt: d.closedAt, lostReason: d.lostReason,
        stage: d.stage, owner: d.owner, _count: d._count,
      })) ?? null,
      quotes: quotes?.map((q) => ({ ...q, grandTotal: q.grandTotal.toFixed(2), taxTotal: q.taxTotal.toFixed(2) })) ?? null,
      samples: samples?.map((s) => ({ ...s, quantity: s.quantity.toString() })) ?? null,
      orders: orderRows?.map((o) => ({
        id: o.id, orderNumber: o.orderNumber, createdAt: o.createdAt, status: o.status, approvalStatus: o.approvalStatus,
        paymentStatus: o.paymentStatus, vatInvoiceStatus: o.vatInvoiceStatus, quotationNumber: o.quotationNumber,
        itemCount: o.items.length, totalKg: Math.round(o.items.reduce((s, i) => s + i.quantityKg, 0) * 100) / 100,
      })) ?? null,
      collections: collections?.map((c) => ({ ...c, amountGross: c.amountGross.toFixed(2) })) ?? null,
      timeline: timeline.slice(0, 200),
      can: {
        edit: canEdit(p, "customers"),
        manageProfiles: hasSubPrivilege(p, "customers", "manage"),
        logActivity: hasSubPrivilege(p, "sales", "lead_write"),
        quote: hasSubPrivilege(p, "sales", "quote_write"),
        createDeal: hasSubPrivilege(p, "sales", "lead_convert"),
      },
      now,
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
