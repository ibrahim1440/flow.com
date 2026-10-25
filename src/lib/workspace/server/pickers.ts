// «مساحة عملي» — the pickers: people (to assign / invite) and records (to link). Names and ids only.
import { prisma } from "@/lib/db";
import { hasModuleAccess } from "@/lib/auth-shared";
import { seesAllSales } from "@/lib/services/sales/scope";
import { teamCtx, type WsActor } from "./context";

/**
 * purpose=assign: the people the caller may give work to (themself, their direct reports; everyone with
 * assign_any). purpose=invite (participants, reviewer, watchers): every active colleague — name only.
 */
export async function people(actor: WsActor, purpose: string, q: string | null) {
  const text = q?.trim().slice(0, 60) || null;
  const nameFilter = text ? { name: { contains: text, mode: "insensitive" as const } } : {};
  if (purpose === "assign") {
    const ctx = await teamCtx(prisma, actor);
    const where = ctx.assignAny ? { active: true, ...nameFilter } : { active: true, id: { in: [actor.id, ...ctx.directReports] }, ...nameFilter };
    const rows = await prisma.employee.findMany({ where, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 50 });
    return { items: rows.map((r) => ({ ...r, self: r.id === actor.id, report: ctx.directReports.has(r.id) })), canAssignAnyone: ctx.assignAny };
  }
  const rows = await prisma.employee.findMany({ where: { active: true, ...nameFilter }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 50 });
  return { items: rows.map((r) => ({ ...r, self: r.id === actor.id })) };
}

/** Customers (customers or sales module), leads and deals (sales; a rep's own unless they see all). */
export async function links(actor: WsActor, q: string | null) {
  const text = q?.trim().slice(0, 60) || "";
  if (text.length < 2) return { items: [] };
  const ci = { contains: text, mode: "insensitive" as const };
  const sales = hasModuleAccess(actor.permissions, "sales");
  const seesCustomers = hasModuleAccess(actor.permissions, "customers") || sales;
  const own = seesAllSales(actor.permissions) ? {} : { ownerId: actor.id };
  const [customers, leads, deals] = await Promise.all([
    seesCustomers ? prisma.customer.findMany({ where: { OR: [{ name: ci }, { nameAr: ci }] }, select: { id: true, name: true }, take: 8 }) : [],
    sales ? prisma.lead.findMany({ where: { ...own, OR: [{ companyName: ci }, { contactName: ci }] }, select: { id: true, companyName: true, contactName: true }, take: 8 }) : [],
    sales ? prisma.opportunity.findMany({ where: { ...own, title: ci }, select: { id: true, title: true, customerId: true }, take: 8 }) : [],
  ]);
  return {
    items: [
      ...customers.map((c) => ({ type: "customer", id: c.id, label: c.name })),
      ...leads.map((l) => ({ type: "lead", id: l.id, label: `${l.companyName} · ${l.contactName}` })),
      ...deals.map((d) => ({ type: "deal", id: d.id, label: d.title, customerId: d.customerId })),
    ],
  };
}
