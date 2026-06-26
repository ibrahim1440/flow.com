// Pure permission utilities and constants — no server dependencies.
// Safe to import from both server and client components.
// signToken / verifyToken / JWT_SECRET live in auth.ts (server-only).

export type AccessLevel = "none" | "view" | "edit";

export type ModulePermission = {
  access: AccessLevel;
  sub?: Record<string, boolean>;
};

export type Permissions = Record<string, ModulePermission>;

export type UserPayload = {
  id: string;
  name: string;
  role: string;
  permissions: Permissions;
  preferredLanguage: "ar" | "en";
};

export const ALL_MODULES = [
  "dashboard",
  "inventory",
  "orders",
  "production",
  "qc",
  "packaging",
  "dispatch",
  "history",
  "analytics",
  "labels",
  "employees",
  "cupping",
  "settings",
  "customers",
  "accounting",
] as const;

export type ModuleKey = (typeof ALL_MODULES)[number];

export const MODULE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  inventory: "Inventory",
  orders: "Orders",
  production: "Production",
  qc: "Quality Control",
  packaging: "Packaging",
  dispatch: "Dispatch",
  history: "History",
  analytics: "Analytics",
  labels: "Labels",
  employees: "Employees",
  cupping: "Cupping",
  settings: "System Settings",
  customers: "Customers / CRM",
  accounting: "Accounting",
};

export const MODULE_SUB_PRIVILEGES: Record<string, { key: string; label: string }[]> = {
  inventory: [
    { key: "receive", label: "Receive new beans" },
    { key: "adjust", label: "Edit / adjust stock" },
    { key: "override", label: "Override inventory (force restock cancelled batches)" },
  ],
  orders: [
    { key: "create", label: "Create new orders" },
    { key: "edit", label: "Edit existing orders" },
    { key: "delete", label: "Delete orders" },
    { key: "approve", label: "Approve / reject orders" },
  ],
  production: [
    { key: "start_batch", label: "Start / continue roasting" },
    { key: "blend", label: "Blend batches" },
    { key: "view_history", label: "View completed batches" },
    { key: "cancel_batch", label: "Cancel / delete batches" },
    { key: "edit_date", label: "Edit batch date (retroactive)" },
  ],
  qc: [
    { key: "create_record", label: "Submit QC records" },
    { key: "edit_record", label: "Edit QC records" },
    { key: "view_records", label: "View QC history" },
    { key: "manage", label: "Finalize QC panel / generate guest links" },
  ],
  dispatch: [
    { key: "mark_delivered", label: "Mark as delivered" },
  ],
  labels: [
    { key: "print", label: "Generate / print labels" },
  ],
  employees: [
    { key: "create", label: "Add employees" },
    { key: "edit", label: "Edit employee permissions" },
  ],
  settings: [
    { key: "reset", label: "Factory reset (wipe all data)" },
    { key: "training_reset", label: "Training data reset (wipe demo/training data including catalog)" },
  ],
  customers: [
    { key: "manage", label: "Manage customer roast preferences" },
  ],
  accounting: [
    { key: "settings_manage", label: "Manage accounting settings" },
    { key: "coa_manage", label: "Manage chart of accounts" },
    { key: "tax_category_manage", label: "Manage tax categories" },
    { key: "period_lock", label: "Lock fiscal periods" },
    { key: "period_close", label: "Close fiscal periods" },
    { key: "journal_create", label: "Create journal entries" },
    { key: "journal_submit", label: "Submit journal entries" },
    { key: "journal_approve", label: "Approve journal entries" },
    { key: "journal_post", label: "Post journal entries" },
    { key: "journal_reverse", label: "Reverse posted journal entries" },
    { key: "export_view", label: "View Qoyod export records" },
  ],
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "Admin / Manager",
  inventory: "Inventory Manager",
  roasting: "Head Roaster / Production",
  qc: "Quality Control",
  dispatch: "Dispatch / Logistics",
  custom: "Custom Role",
};

function makeModulePermission(access: AccessLevel, subKeys?: string[]): ModulePermission {
  const perm: ModulePermission = { access };
  if (subKeys && subKeys.length > 0) {
    perm.sub = {};
    for (const key of subKeys) {
      perm.sub[key] = access === "edit";
    }
  }
  return perm;
}

export function buildDefaultPermissions(role: string): Permissions {
  const allEdit = (mod: string): ModulePermission =>
    makeModulePermission("edit", MODULE_SUB_PRIVILEGES[mod]?.map((s) => s.key));
  const allView = (mod: string): ModulePermission =>
    makeModulePermission("view", MODULE_SUB_PRIVILEGES[mod]?.map((s) => s.key));
  const none = (): ModulePermission => ({ access: "none" });

  switch (role) {
    case "admin":
      return Object.fromEntries(ALL_MODULES.map((m) => [m, allEdit(m)]));
    case "inventory":
      return {
        dashboard: allEdit("dashboard"), inventory: allEdit("inventory"),
        orders: none(), production: none(), qc: none(),
        packaging: none(), dispatch: none(), history: none(),
        analytics: none(), labels: none(), employees: none(), cupping: none(), settings: none(),
        customers: none(),
      };
    case "roasting":
      return {
        dashboard: allEdit("dashboard"), inventory: allView("inventory"),
        orders: allView("orders"), production: allEdit("production"),
        qc: none(), packaging: allEdit("packaging"),
        dispatch: none(), history: none(), analytics: none(),
        labels: none(), employees: none(), cupping: allEdit("cupping"), settings: none(),
        customers: none(),
      };
    case "qc":
      return {
        dashboard: allEdit("dashboard"), inventory: none(), orders: none(),
        production: none(), qc: allEdit("qc"), packaging: none(),
        dispatch: none(), history: none(), analytics: none(),
        labels: none(), employees: none(), cupping: allEdit("cupping"), settings: none(),
        customers: none(),
      };
    case "dispatch":
      return {
        dashboard: allEdit("dashboard"), inventory: none(), orders: allView("orders"),
        production: none(), qc: none(), packaging: none(),
        dispatch: allEdit("dispatch"), history: none(), analytics: none(),
        labels: allEdit("labels"), employees: none(), cupping: none(), settings: none(),
        customers: none(),
      };
    default:
      return Object.fromEntries(ALL_MODULES.map((m) => [m, none()]));
  }
}

export function hasModuleAccess(permissions: Permissions, module: string): boolean {
  const perm = permissions[module];
  return !!perm && perm.access !== "none";
}

export function canEdit(permissions: Permissions, module: string): boolean {
  const perm = permissions[module];
  return !!perm && perm.access === "edit";
}

export function canViewOnly(permissions: Permissions, module: string): boolean {
  const perm = permissions[module];
  return !!perm && perm.access === "view";
}

export function hasSubPrivilege(permissions: Permissions, module: string, subKey: string): boolean {
  const perm = permissions[module];
  if (!perm || perm.access === "none") return false;
  if (!perm.sub || !(subKey in perm.sub)) return false;
  return perm.sub[subKey] === true;
}

export function parsePermissions(raw: string | Permissions): Permissions {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return buildDefaultPermissions("custom");
    }
  }
  return raw;
}
