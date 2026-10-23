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
  /** Credential version: a digest of the account's credentials when the token was issued. */
  cv?: string;
  /** The server-side session this token belongs to (AuthSession.id); no session, no access. */
  sid?: string;
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
  // Automation — WhatsApp messages sent by rules on ERP events.
  "automation",
  // Native HR — people, contracts, time, leave, payroll, advances. Self-service is not a
  // module: every login reaches its own HR record at /dashboard/me, scoped server-side.
  "hr",
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
  automation: "Automation / WhatsApp",
  hr: "Human Resources",
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
    // Roasting schedule (ROASTERS.md §6, D4): explicit privileges, granted per user and NEVER through a
    // role default — the roasting role excludes both below. Administrators hold them by role.
    { key: "manage_roasters", label: "Manage roasters, maintenance and operator assignments" },
    { key: "manage_schedule", label: "Plan, approve, move and cancel roasting schedule slots" },
  ],
  qc: [
    { key: "create_record", label: "Submit QC records" },
    { key: "edit_record", label: "Edit QC records" },
    { key: "view_records", label: "View QC history" },
    { key: "manage", label: "Finalize QC panel / generate guest links" },
    // Owner decision D2 (production simplification): approving a batch with fewer evaluators than
    // the minimum (Settings › Production › QC, default 2) is an exceptional approval — a written
    // reason, an explicit confirmation, recorded on the batch. Privileged with a step-up
    // (src/lib/auth/privileged.ts) and therefore NOT part of the qc role's defaults.
    { key: "finalize_override", label: "Exceptional approval with fewer evaluators than the minimum" },
  ],
  dispatch: [
    { key: "mark_delivered", label: "Mark as delivered" },
  ],
  labels: [
    { key: "print", label: "Generate / print labels" },
    // G-20/G-21 printing system (B-9): configuring what everyone prints on is a separate duty
    // from printing. Administrators (role) may always manage them.
    { key: "profile_manage", label: "Create / edit / delete paper and printer profiles" },
    { key: "template_manage", label: "Create / edit / delete saved label presets" },
    // Owner decision 2.1: cupping labels are anonymous; printing scorer names is a separate,
    // administrator-granted permission, and also needs a privacy-confirmed preset.
    { key: "cupping_named_scorers", label: "Print scorer names on cupping labels (privacy-confirmed presets only)" },
  ],
  employees: [
    { key: "create", label: "Add employees" },
    { key: "edit", label: "Edit employee permissions" },
    // Owner decision (19 Oct, users & roles): a "power user" changes OTHER users' roles, permissions
    // and exceptions (src/lib/users/power.ts). Only the administrator grants or removes it.
    { key: "manage_access", label: "Power user: manage other users' permissions" },
  ],
  settings: [
    { key: "reset", label: "Factory reset (wipe all data)" },
    { key: "training_reset", label: "Training data reset (wipe demo/training data including catalog)" },
  ],
  customers: [
    { key: "manage", label: "Manage customer roast preferences" },
    // feat/credit-hold (owner design): placing / lifting a customer's sales hold and giving grace
    // days. A new capability nobody held — permission-backfill writes it adminOnly; the role
    // templates other than admin have no customers access, so no default grants it.
    { key: "sales_hold", label: "Hold sales for a customer, lift the hold, give grace days" },
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
  // Viewing the module shows the rules and the message log. Each key below changes what is
  // sent, or to whom: building a rule decides who gets messaged; the connection key decides
  // which phone they are messaged from and whether anything is sent at all.
  automation: [
    { key: "manage_rules", label: "Create / edit / switch on automation rules" },
    { key: "manage_connection", label: "Link or unlink the WhatsApp number, set the sending mode, send a test" },
    { key: "manage_messages", label: "Retry or cancel individual messages" },
  ],
  // Viewing the module alone shows nothing sensitive. Each key is one duty, and the
  // approving keys never let anyone approve their own request or their own pay (enforced in
  // the services and again by database triggers).
  hr: [
    { key: "directory", label: "See the employee directory (no pay, identity or bank data)" },
    { key: "people_manage", label: "Create and edit people, departments, status and reporting lines" },
    { key: "private_view", label: "See identity, bank and emergency data (every view is audited)" },
    { key: "documents_view", label: "Download employee documents (audited)" },
    { key: "documents_manage", label: "Upload and remove employee documents" },
    { key: "contracts_manage", label: "See and change contracts and pay" },
    { key: "attendance_manage", label: "Record attendance, shifts and manual entries" },
    { key: "attendance_approve", label: "Approve attendance corrections and overtime" },
    { key: "leave_manage", label: "Record leave, opening balances and grants" },
    { key: "leave_approve", label: "Approve or reject leave" },
    { key: "payroll_prepare", label: "Prepare payroll runs and adjustments" },
    { key: "payroll_approve", label: "Approve payroll lines and runs" },
    { key: "payroll_pay", label: "Record payroll payment (does not move money)" },
    { key: "payroll_cancel_approved", label: "Cancel an approved, unpaid payroll run (independent of preparing and approving it)" },
    { key: "advances_manage", label: "Record advance requests and repayments" },
    { key: "advances_approve", label: "Approve or reject advances" },
    { key: "advances_disburse", label: "Record advance disbursement (does not move money)" },
    { key: "recruit", label: "Openings, applicants, interviews, offers and hiring" },
    { key: "assets_manage", label: "Assign and receive company assets" },
    { key: "performance_manage", label: "Training, reviews and HR incidents" },
    { key: "offboard", label: "Separation, clearance and final settlement" },
    { key: "policy_manage", label: "Payroll policy, leave types, contribution rules, account map" },
    { key: "all_branches", label: "Act on people of every branch" },
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

/** Arabic role names for an Arabic interface (same keys as ROLE_LABELS). */
export const ROLE_LABELS_AR: Record<string, string> = {
  admin: "المدير / المسؤول",
  inventory: "مسؤول المخزون",
  roasting: "رئيس التحميص والإنتاج",
  qc: "مراقبة الجودة",
  dispatch: "التسليم والشحن",
  custom: "دور مخصص",
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
      // Owner decision (16 Oct, inventory privileges Option A): stock adjustment and inventory
      // override are privileged (src/lib/auth/privileged.ts) and are NOT part of the role. An
      // ordinary inventory account keeps receiving, the bean and supplier catalogue, materials
      // and every view, and signs in with its PIN alone. adjust / override are granted only
      // individually, to an authorised supervisor, through the second-person permission flow.
      return {
        dashboard: allEdit("dashboard"), inventory: allEdit("inventory", ["adjust", "override"]),
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
        // manage_roasters / manage_schedule withheld (ROASTERS.md §6, D4): any new production key would
        // otherwise reach every roasting account through allEdit. Delegated per user only.
        orders: allView("orders"), production: allEdit("production", ["roast_to_stock", "manage_roasters", "manage_schedule"]),
        qc: none(), packaging: allEdit("packaging"),
        dispatch: none(), history: none(), analytics: none(),
        labels: none(), employees: none(), cupping: allEdit("cupping"), settings: none(),
        customers: none(),
      };
    case "qc":
      return {
        dashboard: allEdit("dashboard"), inventory: none(), orders: none(),
        // qc › finalize_override withheld (owner decision D2): it is privileged, so granting it by
        // default would make every QC account privileged (username + PIN). Granted individually.
        production: none(), qc: allEdit("qc", ["finalize_override"]), packaging: none(),
        dispatch: none(), history: none(), analytics: none(),
        labels: none(), employees: none(), cupping: allEdit("cupping"), settings: none(),
        customers: none(),
      };
    case "dispatch":
      return {
        dashboard: allEdit("dashboard"), inventory: none(), orders: allView("orders"),
        production: none(), qc: none(), packaging: none(),
        dispatch: allEdit("dispatch"), history: none(), analytics: none(),
        // Printing is the dispatch duty; print configuration (profiles, templates) and named scorers are
        // separate duties — administrators by default, granted explicitly otherwise (QA P3-6).
        labels: allEdit("labels", ["cupping_named_scorers", "profile_manage", "template_manage"]), employees: none(), cupping: none(), settings: none(),
        customers: none(),
      };
    default:
      return Object.fromEntries(ALL_MODULES.map((m) => [m, none()]));
  }
}

/**
 * Review N-1 (F4): a malformed entry fails closed. `{}`, `{access: ""}` or a non-string level
 * used to count as access because only "none" was refused. A module is held only when its entry
 * states a level. Every role default and every permission the employees screen writes states
 * one ("view" / "edit" / "none"), so no valid permission set changes meaning.
 */
export function hasModuleAccess(permissions: Permissions, module: string): boolean {
  // Stored JSON, so the declared AccessLevel type is not a guarantee: checked as unknown.
  const level: unknown = permissions[module]?.access;
  return typeof level === "string" && level !== "" && level !== "none";
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
  if (!perm || !hasModuleAccess(permissions, module)) return false;
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
