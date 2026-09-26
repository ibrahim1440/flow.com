// Finance configuration: settings, branches and access, budget categories, cost centres.
// The "recommended categories" installer creates NAMES only — no amounts, no transactions,
// nothing that could be mistaken for the company's figures.
import { prisma } from "@/lib/db";
import { buildDefaultPermissions, hasSubPrivilege, parsePermissions } from "@/lib/auth-shared";
import { parseMoney, fromMinor } from "../money";
import { assertCan, assertScope, audit, COMPANY, FinanceError, getSettings, reqStr, str, type Db, type FinanceActor, type FinanceScope } from "./context";

export async function updateSettings(actor: FinanceActor, body: Record<string, unknown>) {
  assertCan(actor, "settings_manage");
  const before = await getSettings();
  const data: Record<string, unknown> = {};
  const int = (k: string, min: number, max: number) => {
    if (body[k] === undefined) return;
    const v = Number(body[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new FinanceError(`${k} must be ${min}–${max}.`, 400);
    data[k] = v;
  };
  int("reconciliationDueDays", 1, 90);
  int("obligationAlertDays", 0, 90);
  int("conservativeDelayWeeks", 0, 12);
  int("conservativeCollectPct", 1, 100);
  if (body.alertAmountThreshold !== undefined) {
    const v = parseMoney(body.alertAmountThreshold);
    if (v === null || v < 0) throw new FinanceError("Alert amount must be zero or positive.", 400);
    data.alertAmountThreshold = fromMinor(v);
  }
  if (body.alertPercentThreshold !== undefined) {
    const v = Number(body.alertPercentThreshold);
    if (!(v >= 0 && v <= 1000)) throw new FinanceError("Alert percent must be 0–1000.", 400);
    data.alertPercentThreshold = v.toFixed(2);
  }
  if (body.alertThresholdMode !== undefined) {
    if (body.alertThresholdMode !== "EITHER" && body.alertThresholdMode !== "BOTH") throw new FinanceError("Mode must be EITHER or BOTH.", 400);
    data.alertThresholdMode = body.alertThresholdMode;
  }
  if (body.allowSelfApproval !== undefined) throw new FinanceError("Self-approval is not available: a request is always decided by someone other than its requester.", 400);
  return prisma.$transaction(async (tx) => {
    const after = await tx.finSettings.update({ where: { id: "singleton" }, data: { ...data, updatedBy: actor.id } });
    await audit(tx, { action: "settings.updated", entityType: "FinSettings", entityId: "singleton", before, after, userId: actor.id });
    return after;
  });
}

export async function createBranch(actor: FinanceActor, body: Record<string, unknown>) {
  assertCan(actor, "settings_manage");
  assertCan(actor, "all_branches");
  return prisma.$transaction(async (tx) => {
    const b = await tx.finBranch.create({ data: { code: reqStr(body.code, "Code", 30).toUpperCase(), nameEn: reqStr(body.nameEn, "English name", 120), nameAr: str(body.nameAr, 120), createdBy: actor.id } });
    await audit(tx, { action: "branch.created", entityType: "FinBranch", entityId: b.id, after: b, userId: actor.id });
    return b;
  });
}

export async function setBranchAccess(actor: FinanceActor, body: Record<string, unknown>) {
  assertCan(actor, "settings_manage");
  assertCan(actor, "all_branches");
  const employeeId = reqStr(body.employeeId, "Employee", 40);
  const branchId = reqStr(body.branchId, "Branch", 40);
  const grant = body.grant !== false;
  return prisma.$transaction(async (tx) => {
    const [e, b] = await Promise.all([tx.employee.findUnique({ where: { id: employeeId } }), tx.finBranch.findUnique({ where: { id: branchId } })]);
    if (!e || !b) throw new FinanceError("Not found", 404);
    if (grant) await tx.finBranchAccess.upsert({ where: { employeeId_branchId: { employeeId, branchId } }, update: {}, create: { employeeId, branchId, createdBy: actor.id } });
    else await tx.finBranchAccess.deleteMany({ where: { employeeId, branchId } });
    await audit(tx, { action: grant ? "branch_access.granted" : "branch_access.revoked", entityType: "FinBranchAccess", entityId: `${employeeId}:${branchId}`, branchKey: branchId, userId: actor.id });
    return { ok: true };
  });
}

export async function createFinCategory(actor: FinanceActor, body: Record<string, unknown>) {
  assertCan(actor, "settings_manage");
  const kind = body.kind;
  if (kind !== "RECEIPT" && kind !== "PAYMENT") throw new FinanceError("Kind must be RECEIPT or PAYMENT.", 400);
  return prisma.$transaction(async (tx) => {
    const c = await tx.finCategory.create({
      data: { code: reqStr(body.code, "Code", 40).toUpperCase(), nameEn: reqStr(body.nameEn, "English name", 120), nameAr: str(body.nameAr, 120), kind, isOperating: body.isOperating !== false, sortOrder: Number(body.sortOrder) || 0, createdBy: actor.id },
    });
    await audit(tx, { action: "fin_category.created", entityType: "FinCategory", entityId: c.id, after: c, userId: actor.id });
    return c;
  });
}

export async function createCostCenter(actor: FinanceActor, scope: FinanceScope, body: Record<string, unknown>) {
  assertCan(actor, "settings_manage");
  const branchKey = str(body.branchKey, 60) ?? COMPANY;
  assertScope(scope, branchKey);
  return prisma.$transaction(async (tx) => {
    const c = await tx.finCostCenter.create({ data: { code: reqStr(body.code, "Code", 40).toUpperCase(), nameEn: reqStr(body.nameEn, "English name", 120), nameAr: str(body.nameAr, 120), branchKey, createdBy: actor.id } });
    await audit(tx, { action: "cost_center.created", entityType: "FinCostCenter", entityId: c.id, branchKey, after: c, userId: actor.id });
    return c;
  });
}

/** Names only. Idempotent: existing codes are left untouched. */
export const RECOMMENDED_FIN_CATEGORIES = [
  { code: "RC-WHOLESALE", kind: "RECEIPT", nameEn: "Wholesale customer collections", nameAr: "تحصيلات عملاء الجملة", isOperating: true },
  { code: "RC-CAFE", kind: "RECEIPT", nameEn: "Café sales (POS, gross)", nameAr: "مبيعات المقهى (نقاط البيع، إجمالي)", isOperating: true },
  { code: "RC-ONLINE", kind: "RECEIPT", nameEn: "Online store (gateway, gross)", nameAr: "المتجر الإلكتروني (البوابة، إجمالي)", isOperating: true },
  { code: "RC-OTHER", kind: "RECEIPT", nameEn: "Other operating receipts", nameAr: "مقبوضات تشغيلية أخرى", isOperating: true },
  { code: "RC-LOAN", kind: "RECEIPT", nameEn: "Loan proceeds (financing)", nameAr: "متحصلات قروض (تمويل)", isOperating: false },
  { code: "RC-OWNER", kind: "RECEIPT", nameEn: "Owner contributions (financing)", nameAr: "مساهمات المالك (تمويل)", isOperating: false },
  { code: "PY-GREEN", kind: "PAYMENT", nameEn: "Green coffee purchases", nameAr: "مشتريات البن الأخضر", isOperating: true },
  { code: "PY-PACK", kind: "PAYMENT", nameEn: "Bags and labels", nameAr: "الأكياس والملصقات", isOperating: true },
  { code: "PY-SALARY", kind: "PAYMENT", nameEn: "Salaries", nameAr: "الرواتب", isOperating: true },
  { code: "PY-RENT", kind: "PAYMENT", nameEn: "Rent", nameAr: "الإيجار", isOperating: true },
  { code: "PY-UTIL", kind: "PAYMENT", nameEn: "Utilities and operating costs", nameAr: "المرافق والتكاليف التشغيلية", isOperating: true },
  { code: "PY-SHIP", kind: "PAYMENT", nameEn: "Shipping", nameAr: "الشحن", isOperating: true },
  { code: "PY-MKT", kind: "PAYMENT", nameEn: "Marketing", nameAr: "التسويق", isOperating: true },
  { code: "PY-FEES", kind: "PAYMENT", nameEn: "Payment processing and bank fees", nameAr: "رسوم الدفع والرسوم البنكية", isOperating: true },
  { code: "PY-VAT", kind: "PAYMENT", nameEn: "VAT payments", nameAr: "سداد ضريبة القيمة المضافة", isOperating: true },
  { code: "PY-LOAN", kind: "PAYMENT", nameEn: "Loan principal (financing)", nameAr: "سداد أصل القروض (تمويل)", isOperating: false },
  { code: "PY-OWNER", kind: "PAYMENT", nameEn: "Owner drawings (financing)", nameAr: "مسحوبات المالك (تمويل)", isOperating: false },
] as const;

export const RECOMMENDED_ALLOCATION_CATEGORIES = [
  { code: "AL-GREEN", nameEn: "Green coffee purchasing", nameAr: "شراء البن الأخضر", priority: 30 },
  { code: "AL-PACK", nameEn: "Bags and labels", nameAr: "الأكياس والملصقات", priority: 40 },
  { code: "AL-SALARY", nameEn: "Salaries", nameAr: "الرواتب", priority: 10 },
  { code: "AL-RENT", nameEn: "Rent", nameAr: "الإيجار", priority: 20 },
  { code: "AL-OPS", nameEn: "Utilities and operating costs", nameAr: "المرافق والتشغيل", priority: 50 },
  { code: "AL-SHIP", nameEn: "Shipping", nameAr: "الشحن", priority: 60 },
  { code: "AL-MKT", nameEn: "Marketing", nameAr: "التسويق", priority: 70 },
  { code: "AL-VAT", nameEn: "VAT reserve", nameAr: "احتياطي ضريبة القيمة المضافة", priority: 5, isTaxReserve: true },
  { code: "AL-LIAB", nameEn: "Existing liabilities", nameAr: "الالتزامات القائمة", priority: 15 },
  { code: "AL-RESERVE", nameEn: "Operating reserve", nameAr: "الاحتياطي التشغيلي", priority: 80 },
] as const;

export async function installRecommended(actor: FinanceActor, scope: FinanceScope, branchKey: string) {
  assertCan(actor, "settings_manage");
  assertScope(scope, branchKey);
  return prisma.$transaction(async (tx) => {
    let fin = 0, alloc = 0;
    for (const c of RECOMMENDED_FIN_CATEGORIES) {
      const exists = await tx.finCategory.findUnique({ where: { code: c.code } });
      if (!exists) { await tx.finCategory.create({ data: { ...c, createdBy: actor.id } }); fin++; }
    }
    const suffix = branchKey === COMPANY ? "" : `-${(await tx.finBranch.findUniqueOrThrow({ where: { id: branchKey } })).code}`;
    for (const c of RECOMMENDED_ALLOCATION_CATEGORIES) {
      const code = `${c.code}${suffix}`;
      const exists = await tx.allocationCategory.findUnique({ where: { code } });
      if (!exists) {
        const finCode = { "AL-GREEN": "PY-GREEN", "AL-PACK": "PY-PACK", "AL-SALARY": "PY-SALARY", "AL-RENT": "PY-RENT", "AL-OPS": "PY-UTIL", "AL-SHIP": "PY-SHIP", "AL-MKT": "PY-MKT", "AL-VAT": "PY-VAT" }[c.code as string];
        const finCat = finCode ? await tx.finCategory.findUnique({ where: { code: finCode } }) : null;
        await tx.allocationCategory.create({
          data: { code, nameEn: c.nameEn, nameAr: c.nameAr, priority: c.priority, branchKey, fundingType: "OPEN", isTaxReserve: "isTaxReserve" in c ? c.isTaxReserve : false, finCategoryId: finCat?.id ?? null, createdBy: actor.id },
        });
        alloc++;
      }
    }
    await audit(tx, { action: "setup.recommended_installed", entityType: "FinSettings", entityId: "singleton", branchKey, after: { finCategories: fin, allocationCategories: alloc }, userId: actor.id });
    return { finCategories: fin, allocationCategories: alloc };
  });
}

export async function setupData(db: Db, scope: FinanceScope) {
  const [settings, branches, finCategories, costCenters, access] = await Promise.all([
    getSettings(db),
    db.finBranch.findMany({ orderBy: { code: "asc" } }),
    db.finCategory.findMany({ orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { code: "asc" }] }),
    db.finCostCenter.findMany({ where: scope.all ? {} : { branchKey: { in: scope.branchKeys } }, orderBy: { code: "asc" } }),
    scope.all ? db.finBranchAccess.findMany() : Promise.resolve([]),
  ]);
  const employees = await db.employee.findMany({ where: { active: true }, select: { id: true, name: true, role: true, permissions: true }, orderBy: { name: "asc" } });
  const people = employees.map((e) => {
    const p = parsePermissions(e.permissions);
    const perms = Object.keys(p).length ? p : buildDefaultPermissions(e.role);
    const duties = ["budget_approve", "transfer_approve", "spend_override_approve", "period_close"].filter((s) => hasSubPrivilege(perms, "finance", s));
    return { id: e.id, name: e.name, duties, hasFinance: !!perms.finance && perms.finance.access !== "none" };
  });
  return {
    settings, finCategories, costCenters,
    branches: branches.filter((b) => scope.all || scope.branchKeys.includes(b.id)),
    branchAccess: access, people, scope,
  };
}
