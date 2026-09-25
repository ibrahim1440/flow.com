// The operational roles this UAT signs in as, and exactly what each one may do.
//
// Permissions are built from the same MODULE_SUB_PRIVILEGES the application uses, so a
// role here cannot accidentally be granted a privilege key that does not exist — which
// would read as false at runtime and quietly make the role weaker than the test assumes.
import { MODULE_SUB_PRIVILEGES, ALL_MODULES } from "../../../src/lib/auth-shared";

type Access = "none" | "view" | "edit";
type ModulePermission = { access: Access; sub?: Record<string, boolean> };
export type Permissions = Record<string, ModulePermission>;

const subsFor = (mod: string, granted: (key: string) => boolean): Record<string, boolean> =>
  Object.fromEntries((MODULE_SUB_PRIVILEGES[mod] ?? []).map((s) => [s.key, granted(s.key)]));

const edit = (mod: string, only?: string[]): ModulePermission => ({
  access: "edit",
  sub: subsFor(mod, (k) => (only ? only.includes(k) : true)),
});

// Read-only, matching how the application builds a "view" module: the sub-privileges are
// listed but all false. Granting them here would have made these roles stronger than any
// real one and turned the permission tests into fiction — an early version did exactly
// that and appeared to catch a defect that did not exist.
const view = (mod: string): ModulePermission => ({ access: "view", sub: subsFor(mod, () => false) });
const none = (): ModulePermission => ({ access: "none" });

const base = (): Permissions =>
  Object.fromEntries(ALL_MODULES.map((m) => [m, none()])) as Permissions;

const withBase = (p: Permissions): Permissions => ({ ...base(), dashboard: edit("dashboard"), ...p });

export type RoleName =
  | "sales" | "production" | "qc" | "packaging" | "dispatch" | "admin"
  | "crmRep" | "crmManager" | "crmFinance";

export const ROLES: Record<RoleName, { pin: string; name: string; role: string; permissions: Permissions }> = {
  // Sales raises and approves orders and runs the preparation review. It deliberately has
  // no production privilege at all, which is what makes the permission tests meaningful.
  sales: {
    pin: "710011", name: "UAT Sales", role: "custom",
    permissions: withBase({ orders: edit("orders"), customers: edit("customers"), inventory: view("inventory") }),
  },
  production: {
    pin: "710022", name: "UAT Production", role: "custom",
    permissions: withBase({
      production: edit("production", ["start_batch", "blend", "view_history", "cancel_batch", "edit_date"]),
      orders: view("orders"), inventory: view("inventory"),
    }),
  },
  qc: {
    pin: "710033", name: "UAT Quality", role: "custom",
    permissions: withBase({ qc: edit("qc"), production: view("production") }),
  },
  packaging: {
    pin: "710044", name: "UAT Packaging", role: "custom",
    permissions: withBase({ packaging: edit("packaging"), production: view("production"), inventory: view("inventory") }),
  },
  dispatch: {
    pin: "710055", name: "UAT Dispatch", role: "custom",
    permissions: withBase({ dispatch: edit("dispatch"), orders: view("orders") }),
  },
  admin: {
    pin: "710066", name: "UAT Administrator", role: "admin",
    permissions: Object.fromEntries(ALL_MODULES.map((m) => [m, edit(m)])) as Permissions,
  },

  // ── The CRM roles ─────────────────────────────────────────────────────────
  // Three people with genuinely different reach, because the interesting assertions are
  // about the boundaries between them: what a rep may see of a colleague's pipeline, who
  // may approve a discount, and who may sign off somebody's pay.

  /**
   * A salesperson. Owns leads and deals, raises quotations, and may place the order a
   * signed quotation entitles the customer to.
   *
   * Deliberately WITHOUT `lead_assign` — which is the privilege that widens every read in
   * the module from "mine" to "everyone's". A rep who could see the whole pipeline is a rep
   * who can take the customer list with them.
   */
  crmRep: {
    pin: "720011", name: "UAT Sales Rep", role: "custom",
    permissions: withBase({
      sales: edit("sales", [
        "lead_write", "lead_convert", "quote_write", "lead_import", "lead_export",
        // Records a receipt against a deal they own. It creates NO commission by itself —
        // only a Finance approval does — so this is not a self-payment path.
        "collection_submit",
      ]),
      commissions: edit("commissions", ["view_own"]),
      orders: edit("orders", ["create"]),
      customers: view("customers"),
    }),
  },

  /**
   * A sales manager. Sees the whole pipeline, approves discounts, closes and reopens deals,
   * configures the stages, and administers commission plans.
   *
   * Holds `sandbox_collections` because somebody has to be able to drive the synthetic
   * collection source in a test environment; a rep does not, which is what stops a
   * salesperson manufacturing a collection that looks verified and being paid on it.
   */
  crmManager: {
    pin: "720022", name: "UAT Sales Manager", role: "custom",
    permissions: withBase({
      sales: edit("sales"),
      commissions: edit("commissions", ["view_own", "view_team", "manage_plans", "sandbox_collections"]),
      orders: edit("orders", ["create"]),
      customers: edit("customers"),
      inventory: view("inventory"),
    }),
  },

  /**
   * Finance. Approves and pays commission, and can see the team's figures — but holds no
   * sales module at all, so they cannot read the pipeline, and no `manage_plans`, so they
   * cannot change the rate they are approving against.
   */
  crmFinance: {
    pin: "720033", name: "UAT Finance", role: "custom",
    permissions: withBase({
      commissions: edit("commissions", [
        "view_own", "view_team", "approve", "record_payout",
        // The collection decision. Deliberately NOT paired with sales/collection_submit:
        // whoever records a collection may not decide it, and this role cannot record one
        // at all. Finance still holds no sales module — they reach the queue and the
        // evidence through `commissions`, and cannot read the pipeline.
        "collection_verify", "collection_reject", "collection_reverse",
      ]),
    }),
  },
};
