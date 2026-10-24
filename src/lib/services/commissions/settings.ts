import type { Prisma as PrismaNS } from "@/generated/prisma/client";
import type { ClientRules, Components, Duration } from "./builder";

type Tx = PrismaNS.TransactionClient;

/**
 * «إعدادات العمولات» and the opening setup «تهيئة العملاء الحاليين قبل تفعيل العمولات».
 *
 * Owner decisions (binding, 24 Oct):
 *  - new-client window: 12 months with no purchase by default, edited here; a plan inherits it or
 *    overrides it;
 *  - eligibility: forever by default — it ends when the client LAPSES (no collected order for the
 *    lapse period, 12 months by default); a returning client is a new acquisition again;
 *  - an activation date: no COMPONENTS commission on a collection before it; the monthly run
 *    refuses until it is set;
 *  - every existing customer is an existing client (existing-client rate) until the opening setup
 *    says which order is next; every change is logged.
 */

export type CommissionSettingsView = {
  newClientWindow: Duration;
  lapse: Duration;
  eligibility: Duration | null;
  activationDate: Date | null;
  updatedAt: Date | null;
  updatedById: string | null;
};

const unit = (u: string | null | undefined): Duration["unit"] => (u === "DAYS" ? "DAYS" : "MONTHS");

export const DEFAULT_SETTINGS: CommissionSettingsView = {
  newClientWindow: { value: 12, unit: "MONTHS" },
  lapse: { value: 12, unit: "MONTHS" },
  eligibility: null,
  activationDate: null,
  updatedAt: null,
  updatedById: null,
};

export async function getCommissionSettings(tx: Tx): Promise<CommissionSettingsView> {
  const row = await tx.commissionSettings.findUnique({ where: { id: "singleton" } });
  if (!row) return DEFAULT_SETTINGS;
  return {
    newClientWindow: { value: row.newClientWindowValue, unit: unit(row.newClientWindowUnit) },
    lapse: { value: row.lapseValue, unit: unit(row.lapseUnit) },
    eligibility: row.eligibilityValue ? { value: row.eligibilityValue, unit: unit(row.eligibilityUnit) } : null,
    activationDate: row.activationDate,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
  };
}

/** The client rules a COMPONENTS version runs under: the settings, or the plan's own override. */
export function effectiveClientRules(c: Components, s: CommissionSettingsView): ClientRules {
  if (c.orderSequence.inheritSettings) return { window: s.newClientWindow, eligibility: s.eligibility, lapse: s.lapse };
  return { window: c.orderSequence.newClientWindow, eligibility: c.orderSequence.eligibilityAfterAcquisition, lapse: c.orderSequence.lapse };
}

const durOk = (d: unknown): Duration | null => {
  const o = (d ?? {}) as Record<string, unknown>;
  const u = o.unit === "DAYS" ? "DAYS" : o.unit === "MONTHS" ? "MONTHS" : null;
  const v = Number(o.value);
  if (!u || !Number.isInteger(v) || v < 1 || v > (u === "DAYS" ? 3650 : 120)) return null;
  return { value: v, unit: u };
};

const settingsJson = (s: CommissionSettingsView) => ({
  newClientWindow: s.newClientWindow, lapse: s.lapse, eligibility: s.eligibility,
  activationDate: s.activationDate ? s.activationDate.toISOString() : null,
});

/** Save the settings (whole), with a before / after audit row. */
export async function updateCommissionSettings(
  tx: Tx,
  input: { newClientWindow: unknown; lapse: unknown; eligibility: unknown; activationDate: unknown; reason?: string | null; actorId: string },
): Promise<CommissionSettingsView> {
  const window = durOk(input.newClientWindow);
  if (!window) throw { _appCode: 400, message: "فترة العميل الجديد: من 1 إلى 3650 يوماً أو من 1 إلى 120 شهراً.", errorEn: "The new-client window must be 1–3650 days or 1–120 months." };
  const lapse = durOk(input.lapse);
  if (!lapse) throw { _appCode: 400, message: "مدة انقطاع العميل: من 1 إلى 3650 يوماً أو من 1 إلى 120 شهراً.", errorEn: "The lapse period must be 1–3650 days or 1–120 months." };
  let eligibility: Duration | null = null;
  if (input.eligibility !== null && input.eligibility !== undefined && input.eligibility !== "") {
    eligibility = durOk(input.eligibility);
    if (!eligibility) throw { _appCode: 400, message: "مدة الأهلية: فارغة (للأبد) أو من 1 إلى 3650 يوماً أو من 1 إلى 120 شهراً.", errorEn: "The eligibility must be blank (forever) or 1–3650 days or 1–120 months." };
  }
  let activationDate: Date | null = null;
  if (input.activationDate) {
    const raw = String(input.activationDate);
    // A plain date is a Riyadh date: its first moment in Riyadh (UTC+03:00), like every period here.
    activationDate = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+03:00` : raw);
    if (Number.isNaN(activationDate.getTime())) throw { _appCode: 400, message: "تاريخ تفعيل العمولات غير صالح.", errorEn: "The activation date is not a date." };
  }
  const before = await getCommissionSettings(tx);
  const data = {
    newClientWindowValue: window.value, newClientWindowUnit: window.unit,
    lapseValue: lapse.value, lapseUnit: lapse.unit,
    eligibilityValue: eligibility?.value ?? null, eligibilityUnit: eligibility?.unit ?? null,
    activationDate, updatedById: input.actorId,
  };
  await tx.commissionSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
  const after = await getCommissionSettings(tx);
  await tx.commissionAuditLog.create({
    data: { kind: "SETTINGS", source: "SETTINGS", before: settingsJson(before), after: settingsJson(after), reason: input.reason?.trim() || null, actorId: input.actorId },
  });
  return after;
}

// ─── Opening setup ───────────────────────────────────────────────────────────────

export type OpeningChange = {
  customerId: string;
  /** The customer's «المسؤول» (accountOwnerId); undefined = unchanged, null = none. */
  repId?: string | null;
  /** Collected orders before activation; null = existing client (default); undefined = unchanged. */
  priorOrders?: number | null;
  excluded?: boolean;
  exclusionReason?: string | null;
};

export type OpeningRow = {
  customerId: string; name: string; nameAr: string | null; createdAt: Date;
  repId: string | null; repName: string | null; repUsername: string | null;
  priorOrders: number | null; excluded: boolean; exclusionReason: string | null; preExisting: boolean;
};

export async function openingRows(tx: Tx, activationDate: Date | null): Promise<OpeningRow[]> {
  const rows = await tx.customer.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 5000,
    select: {
      id: true, name: true, nameAr: true, createdAt: true, commissionPriorOrders: true,
      newClientCommissionExcluded: true, newClientExclusionReason: true,
      accountOwner: { select: { id: true, name: true, username: true } },
    },
  });
  return rows.map((c) => ({
    customerId: c.id, name: c.name, nameAr: c.nameAr, createdAt: c.createdAt,
    repId: c.accountOwner?.id ?? null, repName: c.accountOwner?.name ?? null, repUsername: c.accountOwner?.username ?? null,
    priorOrders: c.commissionPriorOrders, excluded: c.newClientCommissionExcluded, exclusionReason: c.newClientExclusionReason,
    preExisting: activationDate ? c.createdAt.getTime() < activationDate.getTime() : true,
  }));
}

/**
 * Apply opening changes, all or nothing, each customer's change logged with its before and after.
 * Returns how many customers actually changed.
 */
export async function applyOpeningChanges(
  tx: Tx,
  changes: OpeningChange[],
  opts: { actorId: string; source: "INLINE" | "CSV"; reason?: string | null },
): Promise<{ changed: number }> {
  if (changes.length > 5000) throw { _appCode: 400, message: "5000 عميل كحد أقصى في المرة الواحدة.", errorEn: "At most 5000 customers at once." };
  let changed = 0;
  for (const ch of changes) {
    const c = await tx.customer.findUnique({
      where: { id: ch.customerId },
      select: { id: true, accountOwnerId: true, commissionPriorOrders: true, newClientCommissionExcluded: true, newClientExclusionReason: true },
    });
    if (!c) throw { _appCode: 404, message: `العميل غير موجود: ${ch.customerId}`, errorEn: `Customer not found: ${ch.customerId}` };
    const data: PrismaNS.CustomerUncheckedUpdateInput = {};
    if (ch.repId !== undefined && ch.repId !== c.accountOwnerId) {
      if (ch.repId) {
        const rep = await tx.employee.findUnique({ where: { id: ch.repId }, select: { id: true, active: true } });
        if (!rep || !rep.active) throw { _appCode: 400, message: "المندوب غير موجود أو موقوف.", errorEn: "The rep does not exist or is inactive." };
      }
      data.accountOwnerId = ch.repId;
    }
    if (ch.priorOrders !== undefined && ch.priorOrders !== c.commissionPriorOrders) {
      if (ch.priorOrders !== null && (!Number.isInteger(ch.priorOrders) || ch.priorOrders < 0 || ch.priorOrders > 999)) {
        throw { _appCode: 400, message: "عدد الطلبات السابقة: عدد صحيح من 0 إلى 999، أو فارغ للعميل الحالي.", errorEn: "Prior orders must be a whole number 0–999, or blank for an existing client." };
      }
      data.commissionPriorOrders = ch.priorOrders;
    }
    if (ch.excluded !== undefined && ch.excluded !== c.newClientCommissionExcluded) {
      const reason = (ch.exclusionReason ?? opts.reason ?? "").trim() || "تهيئة العملاء الحاليين قبل تفعيل العمولات";
      Object.assign(data, ch.excluded
        ? { newClientCommissionExcluded: true, newClientExclusionReason: reason.slice(0, 500), newClientExclusionById: opts.actorId, newClientExclusionAt: new Date() }
        : { newClientCommissionExcluded: false, newClientExclusionReason: null, newClientExclusionById: opts.actorId, newClientExclusionAt: new Date() });
    }
    if (Object.keys(data).length === 0) continue;
    await tx.customer.update({ where: { id: c.id }, data });
    await tx.commissionAuditLog.create({
      data: {
        kind: "OPENING", customerId: c.id, source: opts.source, actorId: opts.actorId, reason: opts.reason?.trim() || null,
        before: { repId: c.accountOwnerId, priorOrders: c.commissionPriorOrders, excluded: c.newClientCommissionExcluded },
        after: {
          repId: data.accountOwnerId !== undefined ? data.accountOwnerId as string | null : c.accountOwnerId,
          priorOrders: data.commissionPriorOrders !== undefined ? data.commissionPriorOrders as number | null : c.commissionPriorOrders,
          excluded: data.newClientCommissionExcluded !== undefined ? data.newClientCommissionExcluded as boolean : c.newClientCommissionExcluded,
        },
      },
    });
    changed++;
  }
  return { changed };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────────

export const OPENING_CSV_HEADER = ["customerId", "customer", "rep", "priorOrders", "excluded"];

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** customerId, customer (name), rep (username, else name), priorOrders (blank = existing client), excluded (yes / no). */
export function openingCsv(rows: OpeningRow[]): string {
  const lines = [OPENING_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push([r.customerId, r.name, r.repUsername ?? r.repName ?? "", r.priorOrders === null ? "" : String(r.priorOrders), r.excluded ? "yes" : "no"].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** RFC 4180-ish parser: quoted cells, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) out.push(row);
  return out;
}

const YES = new Set(["yes", "y", "true", "1", "نعم", "x", "✓"]);
const NO = new Set(["no", "n", "false", "0", "لا", ""]);

/**
 * CSV text → opening changes, matched to customers by customerId (else by exact unique name) and to
 * reps by username (else exact unique name; blank = none). Every bad row is reported; nothing is
 * applied by this function.
 */
export function openingChangesFromCsv(
  text: string,
  customers: { id: string; name: string }[],
  reps: { id: string; name: string; username: string | null }[],
): { changes: OpeningChange[]; errors: { line: number; message: string }[] } {
  const rows = parseCsv(text);
  const errors: { line: number; message: string }[] = [];
  if (rows.length === 0) return { changes: [], errors: [{ line: 1, message: "الملف فارغ." }] };
  const head = rows[0].map((h) => h.trim().replace(/^﻿/, ""));
  const col = (k: string) => head.indexOf(k);
  if (col("customer") < 0 && col("customerId") < 0) errors.push({ line: 1, message: "العمود customer أو customerId مطلوب." });
  for (const k of ["rep", "priorOrders", "excluded"]) if (col(k) < 0) errors.push({ line: 1, message: `العمود ${k} مطلوب.` });
  if (errors.length) return { changes: [], errors };

  const byId = new Map(customers.map((c) => [c.id, c]));
  const byName = new Map<string, string[]>();
  for (const c of customers) byName.set(c.name.trim(), [...(byName.get(c.name.trim()) ?? []), c.id]);
  const repBy = (v: string): string | null | "?" => {
    const t = v.trim();
    if (!t) return null;
    const u = reps.find((r) => r.username && r.username.toLowerCase() === t.toLowerCase());
    if (u) return u.id;
    const n = reps.filter((r) => r.name.trim() === t);
    return n.length === 1 ? n[0].id : "?";
  };

  const changes: OpeningChange[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k: string) => (col(k) >= 0 ? (r[col(k)] ?? "").trim() : "");
    let customerId = get("customerId");
    if (customerId && !byId.has(customerId)) { errors.push({ line, message: `لا يوجد عميل بالمعرّف ${customerId}.` }); return; }
    if (!customerId) {
      const ids = byName.get(get("customer")) ?? [];
      if (ids.length !== 1) { errors.push({ line, message: ids.length === 0 ? `لا يوجد عميل باسم «${get("customer")}».` : `أكثر من عميل باسم «${get("customer")}»؛ استخدم customerId.` }); return; }
      customerId = ids[0];
    }
    if (seen.has(customerId)) { errors.push({ line, message: "العميل مكرر في الملف." }); return; }
    seen.add(customerId);
    const repId = repBy(get("rep"));
    if (repId === "?") { errors.push({ line, message: `المندوب «${get("rep")}» غير معروف أو غير فريد.` }); return; }
    const p = get("priorOrders");
    const priorOrders = p === "" ? null : /^\d{1,3}$/.test(p) ? Number(p) : NaN;
    if (Number.isNaN(priorOrders)) { errors.push({ line, message: `priorOrders «${p}» ليس عدداً صحيحاً من 0 إلى 999.` }); return; }
    const ex = get("excluded").toLowerCase();
    if (!YES.has(ex) && !NO.has(ex)) { errors.push({ line, message: `excluded «${get("excluded")}» يجب أن يكون yes أو no.` }); return; }
    changes.push({ customerId, repId, priorOrders, excluded: YES.has(ex) });
  });
  return { changes, errors };
}
