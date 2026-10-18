import { hasModuleAccess, type Permissions } from "@/lib/auth-shared";

/**
 * Who may see identifiable customer information on the dashboards (owner decision F4, 18 Oct
 * 2026): «Ordinary dashboard users should see aggregated metrics without unnecessary
 * identifiable customer information. Authorized sales and management users may access customer
 * details according to their legitimate permissions.»
 *
 * No new permission: this is exactly the gate of the customer-detail endpoints,
 * GET /api/customers and GET /api/customers/[id] — `requireAnyModule("customers", "orders")`.
 * Whoever may read a customer record there may see customer names and order numbers on the
 * dashboard; everyone else gets aggregates. Enforced by the server in the dashboard APIs
 * (/api/dashboard/today, /api/analytics, /api/dashboard/stats), never by hiding in the page.
 */
export const CUSTOMER_DETAIL_MODULES = ["customers", "orders"] as const;

export function canSeeCustomerDetail(permissions: Permissions): boolean {
  return CUSTOMER_DETAIL_MODULES.some((m) => hasModuleAccess(permissions, m));
}

/**
 * F4 follow-up (review F-1, owner clarification 18 Oct 2026): «for Production, Quality and
 * Packaging roles expose only order identifiers, relevant roasting specifications/preferences,
 * and customer name only where operationally necessary. Never phone, email or delivery address
 * to these roles. Sales/Management keep access per RBAC.»
 *
 * So there are three tiers of customer information:
 *   1. aggregates: everyone with the dashboard;
 *   2. names and order numbers: canSeeCustomerDetail (customers or orders), as on the dashboard,
 *      and the operations screens' own name + roast targets wherever they are gated;
 *   3. the contact record (phone, email, address, WhatsApp opt-out): canSeeCustomerContact,
 *      the customers module itself, which sales, the CRM roles and administrators hold. Holding
 *      orders:view alone (production, dispatch) is NOT this right: those screens draw no contact
 *      field. Dispatch included: its delivery list carries the name only (CUSTOMER_DELIVERY_SELECT).
 */
export function canSeeCustomerContact(permissions: Permissions): boolean {
  return hasModuleAccess(permissions, "customers");
}

/**
 * Without the contact right, GET /api/orders, /api/roasting-batches, /api/qc-records, the
 * customer list and the history export select the customer down to what the operations screens
 * draw, in the query itself: name (EN/AR) and roast targets. (QC records and exports carry no
 * roast targets, so they use the name only.)
 */
export const CUSTOMER_NAME_SELECT = { id: true, name: true, nameAr: true } as const;
export const CUSTOMER_OPERATIONS_SELECT = { ...CUSTOMER_NAME_SELECT, roastPreferences: true } as const;

/**
 * GET /api/deliveries, which only the dispatch module can read. Owner policy F4: Production,
 * Quality and Packaging must never receive phone, email or delivery address, and a dispatch
 * holder may also hold those roles (one combined operations persona). No screen draws a contact
 * field from this list, so without the customers module it carries the name only; customers
 * module holders keep the full record.
 */
export const CUSTOMER_DELIVERY_SELECT = CUSTOMER_NAME_SELECT;

/** An order reduced to what carries no customer identity: its line count, kg and line states. */
export function anonymousOrder(o: { items: { productionStatus: string; deliveryStatus: string; quantityKg: number; beanTypeName?: string }[] }) {
  return {
    itemCount: o.items.length,
    totalKg: Math.round(o.items.reduce((s, i) => s + i.quantityKg, 0) * 10) / 10,
    items: o.items.map((i) => ({ productionStatus: i.productionStatus, deliveryStatus: i.deliveryStatus, quantityKg: i.quantityKg })),
  };
}
