// «استيراد الأصول الثابتة من قيود» (batch 22 WP-G, owner answer 6; 20261129090000_fa_import). The asset register kept
// in Qoyod comes in once, before the opening is posted, as OPENING assets: cost and the accumulated depreciation at the
// day before go-live, exactly as Qoyod holds them (the Qoyod figure is the truth — the schedule spreads what is left over
// the remaining life from go-live: no catch-up, ./schedule.ts basisAccumulated).
//
//   • the CSV template (UTF-8, a header row; English or Arabic headers) — importTemplateCsv();
//   • a preview first (previewImport): every row checked, errors per row and column, warnings (an accumulated figure far
//     from straight line, a category whose accounts are not mapped yet), the totals per category account beside the
//     control totals the accountant types from Qoyod's trial balance;
//   • commitImport: ALL OR NOTHING in one transaction under the opening lock — each asset created and activated through
//     the register's own path (an OPENING event, no entry). The file's sha256 is the batch key: the same file again
//     REPLAYS the live import (nothing doubles);
//   • undoImport («إلغاء الاستيراد»): before the opening is posted, the batch's assets (and their OPENING events) are
//     removed — the database allows exactly that, inside this undo only (fixed_asset_no_delete); after, it is final;
//   • the tie-out (importTieOut): Σ register vs the control totals, and the opening grid's other lines on the same
//     accounts (applyFaOpening refuses them unless confirmed — no double counting).
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { Decimal, ZERO } from "../money";
import { addDaysUtc, dayText, isBusinessDay, parseBusinessDay, riyadhDay } from "../dates";
import { setAuditContext, type AuditContext } from "../audit";
import { opsRefuse } from "../ops/refusals";
import { categoryAccountsSoft, dec, type Tx } from "./common";
import { cleanAsset, activateAssetIn, checkLeaseTerm } from "./assets";
import { accumulatedTarget, doubleDecliningRate } from "./schedule";
import { faOpeningPreview } from "./opening";

type Db = Tx | typeof prisma;

export const FA_IMPORT_MAX_ROWS = 2000;
const IMPORT_TX = { timeout: 180_000, maxWait: 15_000 } as const;

/** The template columns, in order, with the Arabic headers accepted for each (Qoyod's export words first). */
export const FA_IMPORT_COLUMNS = [
  { key: "code", required: true, ar: "الرمز", aliases: ["رمز الأصل", "المرجع", "الكود", "reference"] },
  { key: "name_ar", required: true, ar: "الاسم", aliases: ["اسم الأصل", "الاسم بالعربية", "name"] },
  { key: "name_en", required: false, ar: "الاسم بالإنجليزية", aliases: ["الاسم الانجليزي", "الاسم بالانجليزية"] },
  { key: "category_code", required: true, ar: "رمز التصنيف", aliases: ["التصنيف", "الفئة", "category"] },
  { key: "location", required: false, ar: "الموقع", aliases: ["الفرع", "المشروع", "branch"] },
  { key: "acquisition_date", required: true, ar: "تاريخ الشراء", aliases: ["تاريخ الاقتناء", "تاريخ الشراء (YYYY-MM-DD)"] },
  { key: "in_service_date", required: true, ar: "تاريخ بدء الاستخدام", aliases: ["تاريخ بدء الإهلاك", "بداية الاستخدام"] },
  { key: "cost", required: true, ar: "التكلفة", aliases: ["تكلفة الأصل", "قيمة الشراء"] },
  { key: "residual_value", required: false, ar: "القيمة المتبقية", aliases: ["قيمة الخردة", "القيمة التخريدية"] },
  { key: "useful_life_months", required: true, ar: "العمر الإنتاجي (شهر)", aliases: ["العمر الإنتاجي", "العمر بالأشهر"] },
  { key: "accumulated_depreciation", required: true, ar: "مجمع الإهلاك", aliases: ["الإهلاك المتراكم", "مجمع الاهلاك"] },
  { key: "method", required: false, ar: "الطريقة", aliases: ["طريقة الإهلاك"] },
  { key: "declining_rate_percent", required: false, ar: "نسبة القسط المتناقص", aliases: ["النسبة السنوية"] },
  { key: "serial_number", required: false, ar: "الرقم التسلسلي", aliases: ["السيريال"] },
  { key: "notes", required: false, ar: "ملاحظات", aliases: ["الملاحظات", "الوصف"] },
  { key: "lease_end_date", required: false, ar: "نهاية عقد الإيجار", aliases: ["تاريخ نهاية العقد"] },
] as const;
export type ColumnKey = (typeof FA_IMPORT_COLUMNS)[number]["key"];

/** The template: a UTF-8 BOM (Excel opens Arabic right), the English header keys, and one example row. */
export function importTemplateCsv(): string {
  const head = FA_IMPORT_COLUMNS.map((c) => c.key).join(",");
  const example = ["FA-Q-001", "محمصة 15 كغ", "15 kg roaster", "ROASTERS", "", "2023-01-01", "2023-01-15", "120000.00", "12000.00", "120", "36900.00", "STRAIGHT_LINE", "", "SN-1501", "مستورد من قيود", ""];
  return `﻿${head}\r\n${example.map(csvCell).join(",")}\r\n`;
}
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** RFC 4180 CSV (quoted fields, "" escapes, CRLF / LF), a leading BOM dropped. Also «;» separated when the header has no comma. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = !firstLine.includes(",") && firstLine.includes(";") ? ";" : firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && src[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const normHead = (h: string) => h.replace(/^﻿/, "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const HEADER_MAP = new Map<string, ColumnKey>(FA_IMPORT_COLUMNS.flatMap((c) => [c.key, c.ar, ...c.aliases].map((h) => [normHead(h), c.key] as [string, ColumnKey])));
/** Arabic-Indic digits and the Arabic decimal / thousands marks to Latin (an Excel export in Arabic locale). */
const latin = (v: string) => v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/٫/g, ".").replace(/[٬,\s]/g, "");

export type Issue = { row: number; column: ColumnKey | null; en: string; ar: string };
export type ControlTotal = { key: string; cost?: string | null; accumulated?: string | null };
export type PreviewRow = {
  row: number; code: string; nameAr: string; category: string | null; location: string | null; acquisitionDate: string; inServiceDate: string;
  cost: string; residualValue: string; usefulLifeMonths: number | null; accumulated: string; method: string; expected: string | null; ok: boolean;
};
export type TieGroup = { key: string; categories: string[]; costAccount: { id: string; code: string; name: string } | null; accumAccount: { id: string; code: string; name: string } | null; cost: string; accumulated: string; rows: number; controlCost: string | null; controlAccumulated: string | null; costDiff: string | null; accumulatedDiff: string | null };

type Clean = { row: number; input: Parameters<typeof cleanAsset>[1]; cost: Decimal; accumulated: Decimal; categoryId: string };

const issue = (row: number, column: ColumnKey | null, en: string, ar: string): Issue => ({ row, column, en, ar });
const money2 = (v: string): Decimal | null => {
  const t = latin(v);
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(t)) return null;
  return new Decimal(t);
};
const isoDay = (v: string): string | null => {
  const t = latin(v).replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return null;
  const s = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return isBusinessDay(s) ? s : null;
};
const METHOD: Record<string, "STRAIGHT_LINE" | "DECLINING_BALANCE"> = {
  straight_line: "STRAIGHT_LINE", "straight line": "STRAIGHT_LINE", sl: "STRAIGHT_LINE", "قسط ثابت": "STRAIGHT_LINE", "القسط الثابت": "STRAIGHT_LINE",
  declining_balance: "DECLINING_BALANCE", "declining balance": "DECLINING_BALANCE", db: "DECLINING_BALANCE", "قسط متناقص": "DECLINING_BALANCE", "القسط المتناقص": "DECLINING_BALANCE",
};

/** sha256 of the file as uploaded (the batch key: one live import per file). */
export const fileChecksum = (text: string) => createHash("sha256").update(text.replace(/^﻿/, ""), "utf8").digest("hex");

/** Read and check the whole file against the register, the categories, the locations and the go-live date. */
async function analyse(db: Db, text: string, controls: ControlTotal[] | null | undefined) {
  const fileIssues: Issue[] = [];
  const st = await db.accountingSettings.findUnique({ where: { id: "singleton" }, select: { goLiveDate: true, openingEntryId: true } });
  const goLive = st?.goLiveDate ?? null;
  if (!goLive) fileIssues.push(issue(0, null, "Set the accounting go-live date first (Accounting › Settings): opening assets are valued at the day before it.", "حدّد تاريخ بدء المحاسبة أولًا (المحاسبة › الإعدادات): الأصول الافتتاحية تُقيَّم في اليوم السابق له."));
  else if (goLive.getUTCDate() !== 1) fileIssues.push(issue(0, null, `The go-live date (${dayText(goLive)}) is not the 1st of a month: the register needs it on the 1st.`, `تاريخ بدء المحاسبة (${dayText(goLive)}) ليس أول الشهر: سجل الأصول يحتاجه أول يوم في الشهر.`));
  const openingPosted = !!st?.openingEntryId;
  if (openingPosted) fileIssues.push(issue(0, null, "The opening balances are posted: the import is closed (the register's opening is final).", "رُحّلت الأرصدة الافتتاحية: أُغلق الاستيراد (افتتاحي السجل نهائي)."));

  const table = parseCsv(text);
  if (table.length < 2) fileIssues.push(issue(0, null, "The file has no data rows (a header row, then one row per asset).", "الملف بلا صفوف بيانات (صف العناوين ثم صف لكل أصل)."));
  if (table.length - 1 > FA_IMPORT_MAX_ROWS) fileIssues.push(issue(0, null, `At most ${FA_IMPORT_MAX_ROWS} assets per file.`, `${FA_IMPORT_MAX_ROWS} أصل على الأكثر في الملف.`));
  const header = (table[0] ?? []).map((h) => HEADER_MAP.get(normHead(h)) ?? null);
  const unknown = (table[0] ?? []).filter((h, i) => h.trim() && !header[i]);
  if (unknown.length) fileIssues.push(issue(0, null, `Unknown column(s): ${unknown.join(", ")} (use the template's headers).`, `أعمدة غير معروفة: ${unknown.join("، ")} (استخدم عناوين القالب).`));
  const dup = header.filter((h, i) => h && header.indexOf(h) !== i);
  if (dup.length) fileIssues.push(issue(0, null, `Column(s) given twice: ${[...new Set(dup)].join(", ")}.`, `أعمدة مكررة: ${[...new Set(dup)].join("، ")}.`));
  let missingRequired = false;
  for (const c of FA_IMPORT_COLUMNS) if (c.required && table.length && !header.includes(c.key)) missingRequired = !!fileIssues.push(issue(0, c.key, `The required column «${c.key}» is missing.`, `العمود المطلوب «${c.ar}» غير موجود.`));

  const categories = await db.fixedAssetCategory.findMany();
  const catByCode = new Map(categories.map((c) => [c.code.toUpperCase(), c]));
  const branches = await db.finBranch.findMany({ select: { id: true, code: true, nameAr: true, nameEn: true } });
  const findBranch = (v: string) => {
    const t = v.trim().toLowerCase();
    return branches.find((b) => b.code.toLowerCase() === t || (b.nameAr ?? "").trim().toLowerCase() === t || b.nameEn.trim().toLowerCase() === t) ?? null;
  };
  const rows = missingRequired ? [] : table.slice(1);
  const codes = rows.map((r) => (r[header.indexOf("code")] ?? "").trim());
  const existing = new Set((await db.fixedAsset.findMany({ where: { code: { in: codes.filter(Boolean) } }, select: { code: true } })).map((a) => a.code));

  const issues: Issue[] = [], warnings: Issue[] = [], preview: PreviewRow[] = [], clean: Clean[] = [];
  const today = riyadhDay();
  const seen = new Map<string, number>();
  rows.forEach((r, idx) => {
    const n = idx + 2; // the spreadsheet row number (row 1 is the header)
    const get = (k: ColumnKey) => { const i = header.indexOf(k); return i < 0 ? "" : (r[i] ?? "").trim(); };
    const before = issues.length;
    const err = (k: ColumnKey | null, en: string, ar: string) => issues.push(issue(n, k, en, ar));
    const code = get("code");
    if (!code) err("code", "The code is required.", "الرمز مطلوب.");
    else if (code.length > 40) err("code", "The code is at most 40 characters.", "الرمز 40 حرفًا على الأكثر.");
    else if (existing.has(code)) err("code", `The code ${code} is used by an asset of the register already.`, `الرمز ${code} مستخدم لأصل في السجل.`);
    else if (seen.has(code)) err("code", `The code ${code} is repeated (row ${seen.get(code)}).`, `الرمز ${code} مكرر (الصف ${seen.get(code)}).`);
    if (code) seen.set(code, seen.get(code) ?? n);
    const nameAr = get("name_ar"), nameEn = get("name_en");
    if (!nameAr) err("name_ar", "The Arabic name is required.", "الاسم بالعربية مطلوب.");
    else if (nameAr.length > 200) err("name_ar", "The name is at most 200 characters.", "الاسم 200 حرف على الأكثر.");
    if (nameEn.length > 200) err("name_en", "The English name is at most 200 characters.", "الاسم بالإنجليزية 200 حرف على الأكثر.");
    const cat = catByCode.get(get("category_code").toUpperCase()) ?? null;
    if (!get("category_code")) err("category_code", "The category code is required.", "رمز التصنيف مطلوب.");
    else if (!cat) err("category_code", `No category with the code ${get("category_code")} (Fixed assets › Categories).`, `لا يوجد تصنيف بالرمز ${get("category_code")} (الأصول الثابتة › التصنيفات).`);
    else if (!cat.isActive) err("category_code", `The category ${cat.code} is inactive.`, `التصنيف ${cat.code} غير نشط.`);
    const loc = get("location");
    const branch = loc ? findBranch(loc) : null;
    if (loc && !branch) err("location", `No location (branch) with the code or name «${loc}».`, `لا يوجد موقع (فرع) بالرمز أو الاسم «${loc}».`);
    const acq = isoDay(get("acquisition_date")), ins = isoDay(get("in_service_date"));
    if (!acq) err("acquisition_date", "The acquisition date is YYYY-MM-DD.", "تاريخ الشراء بصيغة YYYY-MM-DD.");
    if (!ins) err("in_service_date", "The in-service date is YYYY-MM-DD.", "تاريخ بدء الاستخدام بصيغة YYYY-MM-DD.");
    const acqD = acq ? parseBusinessDay(acq) : null, insD = ins ? parseBusinessDay(ins) : null;
    if (acqD && goLive && !(acqD < goLive)) err("acquisition_date", `The acquisition date is before go-live (${dayText(goLive)}).`, `تاريخ الشراء قبل بدء المحاسبة (${dayText(goLive)}).`);
    if (acqD && acqD > today) err("acquisition_date", "The acquisition date is not in the future.", "تاريخ الشراء ليس في المستقبل.");
    if (acqD && insD && insD < acqD) err("in_service_date", "The in-service date is on or after the acquisition date.", "تاريخ بدء الاستخدام في تاريخ الشراء أو بعده.");
    if (insD && goLive && !(insD < goLive)) err("in_service_date", `The in-service date is before go-live (${dayText(goLive)}).`, `تاريخ بدء الاستخدام قبل بدء المحاسبة (${dayText(goLive)}).`);
    if (insD && insD > today) err("in_service_date", "The in-service date is not in the future.", "تاريخ بدء الاستخدام ليس في المستقبل.");
    const cost = money2(get("cost"));
    if (!cost || !cost.gt(0)) err("cost", "The cost is above zero, at most 2 decimals.", "التكلفة أكبر من صفر بخانتين عشريتين كحد أقصى.");
    const residualText = get("residual_value");
    const residual = residualText ? money2(residualText) : ZERO;
    if (!residual || residual.isNegative()) err("residual_value", "The residual value is zero or more, at most 2 decimals.", "القيمة المتبقية صفر أو أكثر بخانتين عشريتين كحد أقصى.");
    else if (cost && cost.gt(0) && !residual.lt(cost)) err("residual_value", "The residual value is below the cost.", "القيمة المتبقية أقل من التكلفة.");
    const lifeText = latin(get("useful_life_months"));
    const life = /^\d{1,4}$/.test(lifeText) ? Number(lifeText) : NaN;
    if (!Number.isInteger(life) || life < 1 || life > 600) err("useful_life_months", "The useful life is a whole number of months, 1–600 (the total life from the in-service date).", "العمر الإنتاجي عدد صحيح من الأشهر من 1 إلى 600 (العمر الكلي من تاريخ بدء الاستخدام).");
    const accum = money2(get("accumulated_depreciation"));
    const depreciable = cost && residual ? cost.minus(residual) : null;
    if (!accum || accum.isNegative()) err("accumulated_depreciation", "The accumulated depreciation is zero or more, at most 2 decimals.", "مجمع الإهلاك صفر أو أكثر بخانتين عشريتين كحد أقصى.");
    else if (depreciable && accum.gt(depreciable)) err("accumulated_depreciation", `The accumulated depreciation is at most the depreciable amount (${depreciable.toFixed(2)}).`, `مجمع الإهلاك لا يتجاوز القابل للإهلاك (${depreciable.toFixed(2)}).`);
    const mText = get("method").toLowerCase();
    const method = mText ? METHOD[mText] ?? null : ((cat?.method as "STRAIGHT_LINE" | "DECLINING_BALANCE" | undefined) ?? "STRAIGHT_LINE");
    if (!method) err("method", "The method is STRAIGHT_LINE or DECLINING_BALANCE (قسط ثابت / قسط متناقص).", "الطريقة STRAIGHT_LINE أو DECLINING_BALANCE (قسط ثابت / قسط متناقص).");
    const rateText = latin(get("declining_rate_percent"));
    if (rateText && (!/^\d{1,3}(\.\d{1,4})?$/.test(rateText) || !(Number(rateText) > 0) || Number(rateText) > 100)) err("declining_rate_percent", "The declining rate is above 0 and at most 100 (%).", "نسبة القسط المتناقص أكبر من صفر وحتى 100٪.");
    const leaseText = get("lease_end_date");
    const lease = leaseText ? isoDay(leaseText) : null;
    if (leaseText && !lease) err("lease_end_date", "The lease end date is YYYY-MM-DD.", "نهاية عقد الإيجار بصيغة YYYY-MM-DD.");
    if (cat?.isLeasehold && Number.isInteger(life) && insD) {
      try { checkLeaseTerm(cat, life, insD, lease ? parseBusinessDay(lease) : null); } catch { err("lease_end_date", "A leasehold improvement needs its lease end; its life is at most 60 months and ends by the lease end.", "تحسينات المباني المستأجرة تحتاج نهاية عقد الإيجار، وعمرها 60 شهرًا على الأكثر وينتهي بنهاية العقد."); }
    }
    if (get("serial_number").length > 120) err("serial_number", "The serial number is at most 120 characters.", "الرقم التسلسلي 120 حرفًا على الأكثر.");
    if (get("notes").length > 2000) err("notes", "The notes are at most 2000 characters.", "الملاحظات 2000 حرف على الأكثر.");
    const ok = issues.length === before;
    // The straight-line figure at the day before go-live, for the warning only (the Qoyod figure stands).
    let expected: Decimal | null = null;
    if (ok && cost && residual && accum && insD && goLive && method) {
      expected = accumulatedTarget({ method, decliningRatePercent: method === "DECLINING_BALANCE" ? new Decimal(rateText || (cat?.decliningRatePercent ? String(cat.decliningRatePercent) : doubleDecliningRate(life).toString())) : null,
        inServiceDate: insD, usefulLifeMonths: life, cost, residualValue: residual, basisDate: insD, basisAccumulated: ZERO }, addDaysUtc(goLive, -1));
      const gap = accum.minus(expected).abs();
      if (gap.gt(1) && gap.gt(expected.times("0.10"))) warnings.push(issue(n, "accumulated_depreciation", `${accum.toFixed(2)} is more than 10% away from the ${method === "STRAIGHT_LINE" ? "straight-line" : "schedule"} figure ${expected.toFixed(2)}; the Qoyod figure is kept and the rest spreads over the remaining life.`, `${accum.toFixed(2)} يبعد أكثر من 10٪ عن رقم ${method === "STRAIGHT_LINE" ? "القسط الثابت" : "الجدول"} ${expected.toFixed(2)}؛ يُعتمد رقم قيود ويوزَّع الباقي على العمر المتبقي.`));
      if (depreciable && accum.equals(depreciable)) warnings.push(issue(n, null, "Fully depreciated: it comes in at its residual value and depreciates no further.", "مُهلك بالكامل: يدخل بقيمته المتبقية ولا يُهلك بعدها."));
    }
    preview.push({ row: n, code, nameAr, category: cat?.code ?? (get("category_code") || null), location: branch ? branch.nameAr ?? branch.nameEn : loc || null, acquisitionDate: acq ?? get("acquisition_date"), inServiceDate: ins ?? get("in_service_date"),
      cost: cost ? cost.toFixed(2) : get("cost"), residualValue: residual ? residual.toFixed(2) : residualText, usefulLifeMonths: Number.isInteger(life) ? life : null, accumulated: accum ? accum.toFixed(2) : get("accumulated_depreciation"), method: method ?? mText, expected: expected ? expected.toFixed(2) : null, ok });
    if (ok && cat && cost && accum && acq && ins && method) {
      clean.push({ row: n, cost, accumulated: accum, categoryId: cat.id, input: {
        code, nameAr, nameEn: nameEn || null, categoryId: cat.id, branchId: branch?.id ?? null, acquisitionKind: "OPENING", acquisitionDate: acq, inServiceDate: ins,
        cost: cost.toFixed(2), residualValue: (residual ?? ZERO).toFixed(2), usefulLifeMonths: life, method, decliningRatePercent: method === "DECLINING_BALANCE" && rateText ? rateText : null,
        openingAccumulated: accum.toFixed(2), serialNumber: get("serial_number") || null, notes: get("notes") || null, leaseEndDate: lease,
      } });
    }
  });

  // Totals per category account (the opening grid's lines), beside the control totals typed from Qoyod.
  const used = categories.filter((c) => clean.some((x) => x.categoryId === c.id));
  const accById = new Map<string, { id: string; code: string; name: string }>();
  const soft = new Map<string, Awaited<ReturnType<typeof categoryAccountsSoft>>>();
  for (const c of used) soft.set(c.id, await categoryAccountsSoft(db, c));
  const accIds = [...new Set([...soft.values()].flatMap((s) => [s.cost, s.accum]).filter((x): x is string => !!x))];
  for (const a of accIds.length ? await db.account.findMany({ where: { id: { in: accIds } }, select: { id: true, code: true, nameAr: true, nameEn: true } }) : []) accById.set(a.id, { id: a.id, code: a.code, name: a.nameAr ?? a.nameEn });
  const groups = new Map<string, TieGroup>();
  for (const x of clean) {
    const c = categories.find((k) => k.id === x.categoryId)!;
    const s = soft.get(c.id)!;
    const key = `${s.cost ?? `cat:${c.code}`}|${s.accum ?? `cat:${c.code}`}`;
    const g = groups.get(key) ?? { key, categories: [], costAccount: s.cost ? accById.get(s.cost) ?? null : null, accumAccount: s.accum ? accById.get(s.accum) ?? null : null, cost: "0.00", accumulated: "0.00", rows: 0, controlCost: null, controlAccumulated: null, costDiff: null, accumulatedDiff: null };
    if (!g.categories.includes(c.code)) g.categories.push(c.code);
    g.cost = dec(g.cost).plus(x.cost).toFixed(2); g.accumulated = dec(g.accumulated).plus(x.accumulated).toFixed(2); g.rows++;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const ct = (controls ?? []).find((c) => c.key === g.key);
    const num = (v: string | null | undefined) => { if (v === null || v === undefined || String(v).trim() === "") return null; const d = money2(String(v)); return d ? d.toFixed(2) : null; };
    g.controlCost = num(ct?.cost); g.controlAccumulated = num(ct?.accumulated);
    g.costDiff = g.controlCost === null ? null : dec(g.cost).minus(g.controlCost).toFixed(2);
    g.accumulatedDiff = g.controlAccumulated === null ? null : dec(g.accumulated).minus(g.controlAccumulated).toFixed(2);
    if (!g.costAccount || !g.accumAccount) warnings.push(issue(0, "category_code", `The accounts of ${g.categories.join(", ")} are not mapped yet (no chart, or the FA roles unmapped): map them before writing the opening.`, `حسابات ${g.categories.join("، ")} غير مربوطة بعد (لا دليل حسابات أو أدوار الأصول غير مربوطة): اربطها قبل كتابة الأرصدة الافتتاحية.`));
    if ((g.costDiff && !dec(g.costDiff).isZero()) || (g.accumulatedDiff && !dec(g.accumulatedDiff).isZero())) warnings.push(issue(0, null, `${g.categories.join(", ")}: the file differs from Qoyod's trial balance (cost ${g.costDiff ?? "—"}, accumulated ${g.accumulatedDiff ?? "—"}).`, `${g.categories.join("، ")}: الملف يختلف عن ميزان مراجعة قيود (التكلفة ${g.costDiff ?? "—"}، مجمع الإهلاك ${g.accumulatedDiff ?? "—"}).`));
  }
  const all = [...fileIssues, ...issues];
  const totalCost = clean.reduce((t, x) => t.plus(x.cost), ZERO), totalAccum = clean.reduce((t, x) => t.plus(x.accumulated), ZERO);
  return {
    goLiveDate: goLive ? dayText(goLive) : null, valuedAt: goLive ? dayText(addDaysUtc(goLive, -1)) : null, openingPosted,
    ok: all.length === 0 && clean.length > 0 && clean.length === rows.length, rows: preview, issues: all, warnings, clean,
    totals: { rows: rows.length, valid: clean.length, cost: totalCost.toFixed(2), accumulated: totalAccum.toFixed(2), netBookValue: totalCost.minus(totalAccum).toFixed(2) },
    groups: [...groups.values()],
  };
}

const importView = (i: { id: string; fileName: string; checksum: string; rows: number; totalCost: unknown; totalAccumulated: unknown; controlTotals: unknown; createdBy: string; createdAt: Date; revertedAt: Date | null; revertedBy: string | null }) => ({
  id: i.id, fileName: i.fileName, checksum: i.checksum, rows: i.rows, totalCost: dec(String(i.totalCost)).toFixed(2), totalAccumulated: dec(String(i.totalAccumulated)).toFixed(2),
  controlTotals: (i.controlTotals as ControlTotal[] | null) ?? null, createdBy: i.createdBy, createdAt: i.createdAt.toISOString(), revertedAt: i.revertedAt?.toISOString() ?? null, revertedBy: i.revertedBy,
});

function cleanControls(v: unknown): ControlTotal[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 200) throw opsRefuse("OPS_BAD_INPUT");
  return v.map((x) => ({ key: String((x as ControlTotal)?.key ?? "").slice(0, 200), cost: (x as ControlTotal)?.cost == null ? null : String((x as ControlTotal).cost).slice(0, 20), accumulated: (x as ControlTotal)?.accumulated == null ? null : String((x as ControlTotal).accumulated).slice(0, 20) }));
}
const cleanText = (text: unknown): string => {
  if (typeof text !== "string" || !text.trim()) throw opsRefuse("FA_IMPORT_INVALID", "(empty file)", "(ملف فارغ)");
  if (text.length > 4_000_000) throw opsRefuse("FA_IMPORT_INVALID", "(the file is above 4 MB)", "(الملف أكبر من 4 ميجابايت)");
  return text;
};

/** «معاينة»: nothing is written. `replayOf` names the live import of the same file (importing it again replays it). */
export async function previewImport(input: { text?: unknown; fileName?: unknown; controlTotals?: unknown }) {
  const text = cleanText(input?.text);
  const checksum = fileChecksum(text);
  const a = await analyse(prisma, text, cleanControls(input?.controlTotals));
  const live = await prisma.fixedAssetImport.findFirst({ where: { checksum, revertedAt: null } });
  const { clean: _c, ...rest } = a; void _c;
  return { ...rest, checksum, replayOf: live ? importView(live) : null };
}

/**
 * «استيراد»: ALL OR NOTHING. One transaction under the opening lock (the same lock applyFaOpening and the opening's
 * posting take, so the grid can never be posted half-way through an import): the same file live already → that import
 * is returned (replayed: true); any error → nothing is written (FA_IMPORT_INVALID); else the batch row, then each asset
 * created (OPENING, importId) and activated through the register's own path (an OPENING event at the day before go-live,
 * no entry; basisAccumulated = the Qoyod figure, so the remaining amount spreads over the remaining life).
 */
export async function commitImport(input: { text?: unknown; fileName?: unknown; controlTotals?: unknown }, ctx: AuditContext) {
  const text = cleanText(input?.text);
  const fileName = (typeof input?.fileName === "string" && input.fileName.trim() ? input.fileName.trim() : "qoyod-assets.csv").slice(0, 200);
  const controls = cleanControls(input?.controlTotals);
  const checksum = fileChecksum(text);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? `fixed-asset import ${fileName}` });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('accounting:opening', 0))`;
    const live = await tx.fixedAssetImport.findFirst({ where: { checksum, revertedAt: null } });
    if (live) return { replayed: true, import: importView(live), assets: await tx.fixedAsset.count({ where: { importId: live.id } }) };
    const st = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true } });
    if (st?.openingEntryId) throw opsRefuse("FA_OPENING_FINAL");
    const a = await analyse(tx, text, controls);
    if (!a.ok) {
      const first = a.issues.slice(0, 3).map((i) => `${i.row ? `#${i.row} ` : ""}${i.column ? `${i.column}: ` : ""}${i.en}`).join(" · ");
      const firstAr = a.issues.slice(0, 3).map((i) => `${i.row ? `#${i.row} ` : ""}${i.ar}`).join(" · ");
      throw opsRefuse("FA_IMPORT_INVALID", first || "(no valid rows)", firstAr || "(لا صفوف صالحة)");
    }
    const id = `fai_${randomUUID().replace(/-/g, "")}`;
    const imp = await tx.fixedAssetImport.create({ data: { id, fileName, checksum, rows: a.clean.length, totalCost: a.totals.cost, totalAccumulated: a.totals.accumulated, controlTotals: controls ?? undefined, createdBy: ctx.actorId } });
    for (const row of a.clean) {
      const data = await cleanAsset(tx, row.input, null);
      const asset = await tx.fixedAsset.create({ data: { ...data, code: row.input.code as string, importId: id, status: "DRAFT", createdBy: ctx.actorId, updatedBy: ctx.actorId }, select: { id: true } });
      await activateAssetIn(tx, asset.id, ctx);
    }
    return { replayed: false, import: importView(imp), assets: a.clean.length };
  }, IMPORT_TX);
}

/**
 * «إلغاء الاستيراد»: before the opening is posted, the batch's assets and their OPENING events are removed (the session
 * names the batch for the database guard: SET LOCAL hiqbah.fa_import_undo) and the batch is marked undone (kept: the
 * audit trail holds every deleted row). Refused once the opening is posted (final) or when anything else was recorded on
 * one of its assets since (FA_IMPORT_IN_USE). If the grid carries the tool's lines, they are rewritten by the next
 * «تطبيق على الأرصدة الافتتاحية» (the preview shows the grid out of step until then).
 */
export async function undoImport(importId: string, reason: string | null | undefined, ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: (reason && reason.trim()) || ctx.reason || "undo fixed-asset import" });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('accounting:opening', 0))`;
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "FixedAssetImport" WHERE "id" = ${importId} FOR UPDATE`;
    if (!rows.length) throw opsRefuse("FA_IMPORT_NOT_FOUND");
    const imp = await tx.fixedAssetImport.findUniqueOrThrow({ where: { id: importId } });
    if (imp.revertedAt) throw opsRefuse("FA_IMPORT_UNDONE");
    const st = await tx.accountingSettings.findUnique({ where: { id: "singleton" }, select: { openingEntryId: true } });
    if (st?.openingEntryId) throw opsRefuse("FA_OPENING_FINAL");
    const assets = await tx.fixedAsset.findMany({ where: { importId }, select: { id: true } });
    const ids = assets.map((a) => a.id);
    await tx.$queryRaw`SELECT "id" FROM "FixedAsset" WHERE "id" = ANY(${ids}) FOR UPDATE`;
    const other = await tx.fixedAssetEvent.count({ where: { assetId: { in: ids }, NOT: { kind: "OPENING" } } })
      + await tx.fixedAssetDepreciationLine.count({ where: { assetId: { in: ids } } }) + await tx.fixedAssetAddition.count({ where: { assetId: { in: ids } } }) + await tx.fixedAssetDisposal.count({ where: { assetId: { in: ids } } });
    if (other > 0) throw opsRefuse("FA_IMPORT_IN_USE");
    await tx.$executeRaw`SELECT set_config('hiqbah.fa_import_undo', ${importId}, true)`;
    await tx.fixedAssetEvent.deleteMany({ where: { assetId: { in: ids }, kind: "OPENING" } });
    await tx.fixedAsset.deleteMany({ where: { id: { in: ids }, importId } });
    await tx.$executeRaw`SELECT set_config('hiqbah.fa_import_undo', '', true)`;
    const done = await tx.fixedAssetImport.update({ where: { id: importId }, data: { revertedAt: new Date(), revertedBy: ctx.actorId } });
    return { import: importView(done), removed: ids.length };
  }, IMPORT_TX);
}

export async function listImports() {
  const rows = await prisma.fixedAssetImport.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { _count: { select: { assets: true } } } });
  return rows.map((r) => ({ ...importView(r), assets: r._count.assets }));
}

/**
 * The tie-out after import: per category account, Σ cost and Σ accumulated of the LIVE imports beside the control
 * totals typed at import; the opening tool's state (faOpeningPreview: the grid lines, «inGrid», the manual grid lines on
 * the same accounts that would count twice — applyFaOpening refuses those unless confirmed).
 */
export async function importTieOut() {
  const opening = await faOpeningPreview();
  const live = await prisma.fixedAssetImport.findMany({ where: { revertedAt: null }, select: { id: true, controlTotals: true } });
  const assets = live.length ? await prisma.fixedAsset.findMany({ where: { importId: { in: live.map((l) => l.id) } }, include: { category: true } }) : [];
  const byKey = new Map<string, TieGroup>();
  const soft = new Map<string, Awaited<ReturnType<typeof categoryAccountsSoft>>>();
  for (const a of assets) if (!soft.has(a.categoryId)) soft.set(a.categoryId, await categoryAccountsSoft(prisma, a.category));
  const accIds = [...new Set([...soft.values()].flatMap((s) => [s.cost, s.accum]).filter((x): x is string => !!x))];
  const accs = new Map((accIds.length ? await prisma.account.findMany({ where: { id: { in: accIds } }, select: { id: true, code: true, nameAr: true, nameEn: true } }) : []).map((a) => [a.id, { id: a.id, code: a.code, name: a.nameAr ?? a.nameEn }]));
  const controls = live.flatMap((l) => (l.controlTotals as ControlTotal[] | null) ?? []);
  for (const a of assets) {
    const s = soft.get(a.categoryId)!;
    const key = `${s.cost ?? `cat:${a.category.code}`}|${s.accum ?? `cat:${a.category.code}`}`;
    const g = byKey.get(key) ?? { key, categories: [], costAccount: s.cost ? accs.get(s.cost) ?? null : null, accumAccount: s.accum ? accs.get(s.accum) ?? null : null, cost: "0.00", accumulated: "0.00", rows: 0, controlCost: null, controlAccumulated: null, costDiff: null, accumulatedDiff: null };
    if (!g.categories.includes(a.category.code)) g.categories.push(a.category.code);
    g.cost = dec(g.cost).plus(String(a.cost)).toFixed(2); g.accumulated = dec(g.accumulated).plus(String(a.openingAccumulated ?? 0)).toFixed(2); g.rows++;
    byKey.set(key, g);
  }
  for (const g of byKey.values()) {
    const cs = controls.filter((c) => c.key === g.key);
    const sum = (k: "cost" | "accumulated") => { const v = cs.map((c) => c[k]).filter((x): x is string => !!x && /^\d+(\.\d+)?$/.test(x)); return v.length ? v.reduce((t, x) => t.plus(x), ZERO).toFixed(2) : null; };
    g.controlCost = sum("cost"); g.controlAccumulated = sum("accumulated");
    g.costDiff = g.controlCost === null ? null : dec(g.cost).minus(g.controlCost).toFixed(2);
    g.accumulatedDiff = g.controlAccumulated === null ? null : dec(g.accumulated).minus(g.controlAccumulated).toFixed(2);
  }
  return { groups: [...byKey.values()], opening, doubleCountRisk: opening.otherGridLines.count > 0 };
}
