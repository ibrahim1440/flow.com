/**
 * What an event knows when it is processed: the values its template variables take, and the
 * people its rules may message.
 *
 * The event row carries only the facts of its moment (a status moved from/to, the units
 * shipped). Everything else — names, order numbers, phones, opt-out — is read here, when the
 * dispatcher processes it moments later, from the same database. The newest phone number
 * wins, and the business transaction that raised the event paid for none of these reads.
 *
 * Every event in the catalogue must have a resolver below; tests/automation/catalog.test.ts
 * checks the list.
 */
import type { Prisma } from "@/generated/prisma/client";
import { buildDefaultPermissions, hasSubPrivilege, parsePermissions } from "@/lib/auth-shared";
import type { DynamicRecipient, Lang } from "./catalog";
import type { RenderContext } from "./template";

type Db = Prisma.TransactionClient;

export type Person = {
  /** Stable identity for de-duplication: "customer:<id>", "employee:<id>". */
  key: string;
  name: string;
  phone: string | null;
  optOut?: boolean;
};

export type EventContext = {
  vars: RenderContext;
  people: Partial<Record<DynamicRecipient, Person[]>>;
};

export type StoredEvent = {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  actorId: string | null;
  occurredAt: Date;
};

// ─── Formatting ────────────────────────────────────────────────────────────────

const RIYADH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Riyadh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 2026-10-06 14:30, Riyadh time, Latin digits. */
export function riyadhTime(d: Date | null | undefined): string {
  if (!d) return "";
  const parts = Object.fromEntries(RIYADH.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

export function riyadhDate(d: Date | null | undefined): string {
  return riyadhTime(d).slice(0, 10);
}

/** A decimal string as money with thousands separators — as strings, never via a float. */
export function moneyText(raw: { toString(): string } | null | undefined, currency: string): string {
  if (raw === null || raw === undefined) return "";
  const [int, frac = ""] = raw.toString().split(".");
  const sign = int.startsWith("-") ? "-" : "";
  const grouped = int.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${(frac + "00").slice(0, 2)} ${currency}`;
}

const trimKg = (n: number) => String(Math.round(n * 1000) / 1000);

function unitsText(units: number, lang: Lang): string {
  if (lang === "en") return `${units} unit${units === 1 ? "" : "s"}`;
  return units === 1 ? "وحدة واحدة" : units === 2 ? "وحدتان" : units <= 10 ? `${units} وحدات` : `${units} وحدة`;
}

const payloadOf = (e: StoredEvent): Record<string, unknown> =>
  e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? (e.payload as Record<string, unknown>) : {};

const s = (x: unknown): string => (x === null || x === undefined ? "" : String(x));

// ─── Shared loaders ────────────────────────────────────────────────────────────

type EmployeeRow = { id: string; name: string; phoneNumber: string | null; active: boolean };

const employeePerson = (e: EmployeeRow | null | undefined): Person[] =>
  e && e.active ? [{ key: `employee:${e.id}`, name: e.name, phone: e.phoneNumber }] : [];

async function employee(db: Db, id: string | null | undefined): Promise<EmployeeRow | null> {
  if (!id) return null;
  return db.employee.findUnique({ where: { id }, select: { id: true, name: true, phoneNumber: true, active: true } });
}

type CustomerRow = { id: string; name: string; nameAr: string | null; phone: string | null; whatsappOptOut: boolean };

const customerName = (c: CustomerRow | null | undefined, lang: Lang) => (c ? (lang === "ar" ? c.nameAr || c.name : c.name) : "");

const customerPerson = (c: CustomerRow | null | undefined, lang: Lang): Person[] =>
  c ? [{ key: `customer:${c.id}`, name: customerName(c, lang), phone: c.phone, optOut: c.whatsappOptOut }] : [];

const CUSTOMER_SELECT = { id: true, name: true, nameAr: true, phone: true, whatsappOptOut: true } as const;
const EMPLOYEE_SELECT = { id: true, name: true, phoneNumber: true, active: true } as const;

async function orderContext(db: Db, orderId: string | null | undefined, lang: Lang) {
  if (!orderId) return { vars: {} as RenderContext, customer: null as CustomerRow | null, owner: null as EmployeeRow | null, order: null };
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      customer: { select: CUSTOMER_SELECT },
      owner: { select: EMPLOYEE_SELECT },
      items: {
        orderBy: { createdAt: "asc" },
        select: { beanTypeName: true, quantityUnits: true, quantityKg: true, deliveredUnits: true, deliveredQty: true },
      },
    },
  });
  if (!order) return { vars: {} as RenderContext, customer: null, owner: null, order: null };
  const items = order.items
    .map((i) => `${i.quantityUnits != null ? `${i.quantityUnits} ×` : `${trimKg(i.quantityKg)}kg ×`} ${i.beanTypeName}`)
    .join(lang === "ar" ? "، " : ", ");
  const vars: RenderContext = {
    "order.number": order.orderNumber,
    "order.status": order.status,
    "order.items": items,
    "order.itemCount": order.items.length,
    "customer.name": customerName(order.customer, lang),
    "customer.phone": order.customer.phone ?? "",
    "owner.name": order.owner?.name ?? "",
  };
  return { vars, customer: order.customer, owner: order.owner, order };
}

async function batchContext(db: Db, batchId: string, lang: Lang) {
  const batch = await db.roastingBatch.findUnique({
    where: { id: batchId },
    select: {
      batchNumber: true,
      greenBeanQuantity: true,
      orderItemId: true,
      product: { select: { productNameEn: true, productNameAr: true } },
      greenBean: { select: { beanType: true, beanTypeAr: true } },
      orderItem: { select: { orderId: true } },
    },
  });
  if (!batch) return null;
  const order = await orderContext(db, batch.orderItem?.orderId, lang);
  const productName = batch.product
    ? (lang === "ar" ? batch.product.productNameAr || batch.product.productNameEn : batch.product.productNameEn)
    : (lang === "ar" ? batch.greenBean?.beanTypeAr || batch.greenBean?.beanType : batch.greenBean?.beanType) ?? "";
  const vars: RenderContext = {
    "batch.number": batch.batchNumber,
    "batch.product": productName,
    "batch.greenKg": trimKg(batch.greenBeanQuantity),
    "batch.toStock": batch.orderItemId ? "no" : "yes",
    "order.number": order.order?.orderNumber ?? "",
    "customer.name": order.vars["customer.name"] ?? "",
    "owner.name": order.vars["owner.name"] ?? "",
  };
  return { vars, owner: order.owner };
}

function common(e: StoredEvent, actor: EmployeeRow | null): RenderContext {
  return { "event.time": riyadhTime(e.occurredAt), "actor.name": actor?.name ?? "" };
}

/** Active employees who may decide this finance request — the same test the decision route applies. */
async function eligibleApprovers(db: Db, req: { requiredSub: string; branchKey: string; requestedBy: string }) {
  const [rows, access] = await Promise.all([
    db.employee.findMany({ where: { active: true }, select: { ...EMPLOYEE_SELECT, role: true, permissions: true } }),
    db.finBranchAccess.findMany({ where: { branchId: req.branchKey, branch: { active: true } }, select: { employeeId: true } }),
  ]);
  const branchHolders = new Set(access.map((a) => a.employeeId));
  return rows.filter((e) => {
    if (e.id === req.requestedBy) return false;
    const parsed = parsePermissions(e.permissions);
    const perms = Object.keys(parsed).length ? parsed : buildDefaultPermissions(e.role);
    if (!hasSubPrivilege(perms, "finance", req.requiredSub)) return false;
    return hasSubPrivilege(perms, "finance", "all_branches") || (req.branchKey !== "COMPANY" && branchHolders.has(e.id));
  });
}

// ─── Resolvers, one per event ──────────────────────────────────────────────────

type Resolver = (db: Db, e: StoredEvent, lang: Lang, actor: EmployeeRow | null) => Promise<EventContext | null>;

const RESOLVERS: Record<string, Resolver> = {
  "order.created": async (db, e, lang, actor) => {
    const o = await orderContext(db, e.subjectId, lang);
    if (!o.order) return null;
    return {
      vars: { ...o.vars, ...common(e, actor) },
      people: { customer: customerPerson(o.customer, lang), actor: employeePerson(actor) },
    };
  },

  "order.status_changed": async (db, e, lang, actor) => {
    const p = payloadOf(e);
    const o = await orderContext(db, e.subjectId, lang);
    if (!o.order) return null;
    return {
      vars: { ...o.vars, "status.from": s(p.from), "status.to": s(p.to), "status.reason": s(p.reason), ...common(e, actor) },
      people: {
        customer: customerPerson(o.customer, lang),
        order_owner: employeePerson(o.owner),
        actor: employeePerson(actor),
      },
    };
  },

  "delivery.recorded": async (db, e, lang, actor) => {
    const p = payloadOf(e);
    const delivery = await db.delivery.findUnique({
      where: { id: e.subjectId },
      select: {
        quantityKg: true,
        quantityUnits: true,
        deliveryType: true,
        notes: true,
        orderItem: { select: { beanTypeName: true, orderId: true } },
      },
    });
    if (!delivery) return null;
    const o = await orderContext(db, delivery.orderItem.orderId, lang);
    if (!o.order) return null;
    const fully = o.order.items.every((i) =>
      i.quantityUnits != null ? i.deliveredUnits >= i.quantityUnits : i.deliveredQty >= i.quantityKg - 0.0005,
    );
    const units = delivery.quantityUnits ?? (typeof p.units === "number" ? p.units : null);
    return {
      vars: {
        ...o.vars,
        "delivery.item": delivery.orderItem.beanTypeName,
        "delivery.quantity": units != null ? unitsText(units, lang) : `${trimKg(delivery.quantityKg)} kg`,
        "delivery.type": delivery.deliveryType,
        "delivery.notes": delivery.notes ?? "",
        "order.fullyDelivered": fully ? "yes" : "no",
        ...common(e, actor),
      },
      people: {
        customer: customerPerson(o.customer, lang),
        order_owner: employeePerson(o.owner),
        actor: employeePerson(actor),
      },
    };
  },

  "production.batch_roasted": async (db, e, lang, actor) => {
    const b = await batchContext(db, e.subjectId, lang);
    if (!b) return null;
    return {
      vars: { ...b.vars, ...common(e, actor) },
      people: { order_owner: employeePerson(b.owner), actor: employeePerson(actor) },
    };
  },

  "qc.batch_finalized": async (db, e, lang, actor) => {
    const p = payloadOf(e);
    const b = await batchContext(db, e.subjectId, lang);
    if (!b) return null;
    return {
      vars: { ...b.vars, "qc.outcome": s(p.outcome), "qc.reason": s(p.reason), ...common(e, actor) },
      people: { order_owner: employeePerson(b.owner), actor: employeePerson(actor) },
    };
  },

  "packaging.completed": async (db, e, lang, actor) => {
    const p = payloadOf(e);
    const b = await batchContext(db, e.subjectId, lang);
    if (!b) return null;
    // Packaging can reserve to an order the batch was not roasted for; prefer that order.
    let vars = b.vars;
    let owner = b.owner;
    if (typeof p.reservedOrderId === "string" && p.reservedOrderId) {
      const o = await orderContext(db, p.reservedOrderId, lang);
      if (o.order) {
        vars = { ...vars, "order.number": o.order.orderNumber, "customer.name": o.vars["customer.name"], "owner.name": o.vars["owner.name"] };
        owner = o.owner;
      }
    }
    return {
      vars: {
        ...vars,
        "pack.units": s(p.standardUnits ?? 0),
        "pack.partialUnits": s(p.partialUnits ?? 0),
        "pack.reservedUnits": s(p.reservedUnits ?? 0),
        ...common(e, actor),
      },
      people: { order_owner: employeePerson(owner), actor: employeePerson(actor) },
    };
  },

  "production.order_created": async (db, e, lang, actor) => {
    const po = await db.productionOrder.findUnique({
      where: { id: e.subjectId },
      select: {
        productionNumber: true,
        targetUnits: true,
        expectedGreenBeanKg: true,
        productSku: { select: { skuCode: true } },
        sourceOrderItem: { select: { orderId: true } },
      },
    });
    if (!po) return null;
    const o = await orderContext(db, po.sourceOrderItem?.orderId, lang);
    return {
      vars: {
        "production.number": po.productionNumber,
        "production.sku": po.productSku.skuCode,
        "production.units": po.targetUnits,
        "production.greenKg": trimKg(po.expectedGreenBeanKg),
        "order.number": o.order?.orderNumber ?? "",
        "customer.name": o.vars["customer.name"] ?? "",
        "owner.name": o.vars["owner.name"] ?? "",
        ...common(e, actor),
      },
      people: { order_owner: employeePerson(o.owner), actor: employeePerson(actor) },
    };
  },

  "sales.quote_status_changed": async (db, e, lang, actor) => {
    const p = payloadOf(e);
    const q = await db.quote.findUnique({
      where: { id: e.subjectId },
      select: {
        quoteNumber: true,
        status: true,
        currency: true,
        grandTotal: true,
        validUntil: true,
        rejectionNote: true,
        customer: { select: CUSTOMER_SELECT },
        opportunity: {
          select: { title: true, owner: { select: EMPLOYEE_SELECT }, customer: { select: CUSTOMER_SELECT } },
        },
      },
    });
    if (!q) return null;
    const customer = q.customer ?? q.opportunity.customer;
    return {
      vars: {
        "quote.number": q.quoteNumber,
        "quote.status": s(p.to) || q.status,
        "quote.total": moneyText(q.grandTotal, q.currency),
        "quote.validUntil": riyadhDate(q.validUntil),
        "quote.reason": q.rejectionNote ?? "",
        "deal.title": q.opportunity.title,
        "customer.name": customerName(customer, lang),
        "owner.name": q.opportunity.owner.name,
        ...common(e, actor),
      },
      people: {
        customer: customerPerson(customer, lang),
        deal_owner: employeePerson(q.opportunity.owner),
        actor: employeePerson(actor),
      },
    };
  },

  "sales.task_due": async (db, e, lang) => {
    const a = await db.activity.findUnique({
      where: { id: e.subjectId },
      select: {
        subject: true,
        dueAt: true,
        completedAt: true,
        owner: { select: EMPLOYEE_SELECT },
        lead: { select: { companyName: true, companyNameAr: true } },
        opportunity: { select: { title: true } },
        customer: { select: CUSTOMER_SELECT },
      },
    });
    // Done since it fell due: nothing to remind anyone of.
    if (!a || a.completedAt) return null;
    const related = a.opportunity?.title
      ?? (a.lead ? (lang === "ar" ? a.lead.companyNameAr || a.lead.companyName : a.lead.companyName) : "")
      ?? "";
    return {
      vars: {
        "task.subject": a.subject,
        "task.dueAt": riyadhTime(a.dueAt),
        "task.related": related || customerName(a.customer, lang),
        "owner.name": a.owner.name,
        "event.time": riyadhTime(a.dueAt ?? e.occurredAt),
      },
      people: { task_owner: employeePerson(a.owner) },
    };
  },

  "finance.approval_requested": async (db, e, lang, actor) => {
    const r = await db.finApprovalRequest.findUnique({ where: { id: e.subjectId } });
    if (!r) return null;
    const requester = await employee(db, r.requestedBy);
    const approvers = r.assignedToId ? employeePerson(await employee(db, r.assignedToId)) : (await eligibleApprovers(db, r)).flatMap(employeePerson);
    return {
      vars: {
        "approval.type": r.type,
        "approval.summary": r.summary,
        "approval.reason": r.reason ?? "",
        "approval.requester": requester?.name ?? "",
        ...common(e, actor),
      },
      people: { approver: approvers, requester: employeePerson(requester) },
    };
  },

  "finance.approval_decided": async (db, e, lang, actor) => {
    const r = await db.finApprovalRequest.findUnique({ where: { id: e.subjectId } });
    if (!r) return null;
    const p = payloadOf(e);
    const [requester, decider] = await Promise.all([employee(db, r.requestedBy), employee(db, r.decidedBy)]);
    return {
      vars: {
        "approval.type": r.type,
        "approval.summary": r.summary,
        "approval.decision": s(p.decision) || r.status,
        "approval.note": r.decisionNote ?? "",
        "approval.requester": requester?.name ?? "",
        ...common(e, actor),
      },
      people: { requester: employeePerson(requester), approver: employeePerson(decider) },
    };
  },
};

export const RESOLVED_EVENT_TYPES: readonly string[] = Object.keys(RESOLVERS);

/** Null when the subject no longer exists (or no longer needs a message) — the rules are then skipped. */
export async function resolveEventContext(db: Db, e: StoredEvent, lang: Lang): Promise<EventContext | null> {
  const resolver = RESOLVERS[e.eventType];
  if (!resolver) return null;
  const actor = await employee(db, e.actorId);
  return resolver(db, e, lang, actor);
}

/** A specific employee chosen in a step. */
export async function employeeRecipient(db: Db, employeeId: string): Promise<Person[]> {
  return employeePerson(await employee(db, employeeId));
}
