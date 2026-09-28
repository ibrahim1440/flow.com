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
  "sales",
  "commissions",
  // Finance — cash management, receipt allocation and the monthly cash budget.
  "finance",
] as const;

export type ModuleKey = (typeof ALL_MODULES)[number];

export const MODULE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  sales: "Sales / CRM",
  commissions: "Commissions",
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
  finance: "Finance (Cash & Budget)",
};

export const MODULE_SUB_PRIVILEGES: Record<string, { key: string; label: string }[]> = {
  sales: [
    { key: "lead_write", label: "Create / edit leads" },
    { key: "lead_assign", label: "Assign or reassign a lead's owner" },
    { key: "lead_convert", label: "Convert a lead into a customer and a deal" },
    { key: "lead_import", label: "Import leads from a file" },
    { key: "lead_export", label: "Export leads" },
    { key: "deal_close", label: "Mark a deal Won or Lost" },
    { key: "deal_reopen", label: "Reopen a closed deal" },
    { key: "quote_write", label: "Create / edit quotations" },
    { key: "quote_approve_discount", label: "Approve a discount above the threshold" },
    { key: "stage_manage", label: "Configure pipeline stages" },
    // Collections. Submitting one is a selling act and lives here; DECIDING one is a
    // finance duty and lives under commissions, which is what stops a rep who can record a
    // receipt from also being able to bless it.
    { key: "collection_submit", label: "Record a collection against an owned deal" },
    { key: "collection_view_team", label: "See the team's collections, not only my own" },
  ],
  // Fine-grained on purpose: every key below decides either what somebody is paid or who
  // gets to see it, and "manage_plans" in particular must never fall to the person the
  // plan pays.
  commissions: [
    { key: "view_own", label: "See my own commission" },
    { key: "view_team", label: "See the team's commission" },
    { key: "manage_plans", label: "Create / edit commission plans and assignments" },
    { key: "approve", label: "Approve accrued commission" },
    { key: "record_payout", label: "Record a commission payout" },
    { key: "sandbox_collections", label: "Record sandbox collection events (non-production only)" },
    // The finance duty. Approve and refuse are separate keys because they are separate
    // abilities; a deployment will normally grant them together, and granting only one is
    // an unusual but coherent configuration rather than a broken state.
    //
    // Reversal is its own key and a stronger one: it undoes a figure somebody has already
    // been told they earned, and it is the only act in the module that makes a commission
    // go backwards.
    { key: "collection_verify", label: "Verify a recorded collection (this is what creates commission)" },
    { key: "collection_reject", label: "Reject a recorded collection" },
    { key: "collection_reverse", label: "Reverse an approved collection" },
  ],
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
    { key: "prepare_review", label: "Submit preparation review decisions" },
    { key: "manage_status", label: "Hold / resume / cancel / complete orders" },
  ],
  production: [
    { key: "start_batch", label: "Start / continue roasting" },
    { key: "roast_to_stock", label: "Roast to stock (no order behind the batch)" },
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
    { key: "mapping_manage", label: "Map posting roles to accounts and set the ledger cutover" },
    { key: "policy_prepare", label: "Prepare accounting policy versions" },
    { key: "policy_approve", label: "Approve accounting policies and commission plans for posting" },
    { key: "events_process", label: "Run and retry automatic postings" },
    { key: "unlock_period", label: "Unlock a locked fiscal period (with a reason)" },
    { key: "ap_bill_create", label: "Prepare and submit supplier bills" },
    { key: "ap_bill_approve", label: "Approve or reject supplier bills" },
    { key: "ap_bill_post", label: "Post and reverse supplier bills" },
    { key: "bank_posting_manage", label: "Map cash accounts and budget categories to the ledger; set the bank posting start date" },
    { key: "bank_correction_request", label: "Request the correction (void or replacement) of a posted bank line" },
    { key: "bank_correction_approve", label: "Approve or reject corrections of posted bank lines (not one's own)" },
    { key: "ar_invoice_create", label: "Prepare and submit sales invoices and credit notes; edit customer tax data" },
    { key: "ar_invoice_approve", label: "Approve or reject sales invoices and credit notes (not one's own)" },
    { key: "ar_invoice_post", label: "Post and reverse sales invoices and credit notes" },
    { key: "ar_receipt_assign", label: "Assign customer bank receipts, apply advances and credits" },
    { key: "inv_doc_create", label: "Prepare inventory documents (receipts, issues, production, counts…)" },
    { key: "inv_doc_approve", label: "Approve inventory documents and loss bands" },
    { key: "inv_doc_post", label: "Post inventory documents" },
    { key: "inv_master_manage", label: "Manage inventory items, units, locations and draft loss bands" },
  ],
  // Finance duties are separated on purpose: preparing a budget or a rule does not, by this
  // key alone, allow approving it; and no request can be decided by its own requester
  // (enforced in the service and by database triggers, with no configurable exception).
  finance: [
    { key: "txn_enter", label: "Enter, import and classify bank transactions" },
    { key: "reconcile", label: "Reconcile accounts against bank statements" },
    { key: "budget_prepare", label: "Prepare budgets, obligations, forecasts and allocation rules" },
    { key: "budget_approve", label: "Approve budgets, revisions and allocation percentage changes" },
    { key: "allocate", label: "Run allocations, reserve and record payments" },
    { key: "transfer_approve", label: "Approve transfers between allocation categories" },
    { key: "spend_override_approve", label: "Approve spending above a category limit or balance" },
    { key: "period_close", label: "Close or reopen budget periods" },
    { key: "all_branches", label: "Company-wide access (all branches and company-level records)" },
    { key: "settings_manage", label: "Manage finance settings, accounts, categories and branch access" },
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
  const allEdit = (mod: string, except: string[] = []): ModulePermission =>
    makeModulePermission("edit", MODULE_SUB_PRIVILEGES[mod]?.map((s) => s.key).filter((k) => !except.includes(k)));
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
        // roast_to_stock withheld deliberately: roasting for the shelf is production beyond
        // what any order asked for, which is exactly what the per-order surplus gate makes
        // admin-only. Granting it here by default would have made that gate circumventable
        // by simply omitting the order item. An admin can still turn it on per employee.
        orders: allView("orders"), production: allEdit("production", ["roast_to_stock"]),
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
