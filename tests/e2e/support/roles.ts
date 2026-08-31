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

export type RoleName = "sales" | "production" | "qc" | "packaging" | "dispatch" | "admin";

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
};
