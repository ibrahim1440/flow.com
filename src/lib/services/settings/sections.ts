// Settings › Inventory and Settings › Invoicing & tax (migration 20261022110000_settings_sections).
// Both values live on the "SystemConfig" singleton, the organisation's settings row, beside the
// logo and the quotation settings.
//
// NULL means the owner has not set the value, and the built-in figure the code has always used
// applies — the green-coffee low-stock line of the inventory screen (20 kg) and the VAT percent
// a new quotation line starts with (15%). Setting one changes the figure; nothing else.
//
// Parsing is pure (asserted without a database); reading takes any Prisma client or transaction.
import { parseFiniteDecimal, Decimal } from "../commissions/engine";

/** The inventory screen's «أصناف أقل من 20 كغ» (src/app/dashboard/inventory/_parts/green.tsx). */
export const LOW_STOCK_GREEN_KG_DEFAULT = 20;
export const LOW_STOCK_GREEN_KG_MAX = 100_000;
/** The quotation editor's blank line (src/app/dashboard/sales/quotes/[id]/page.tsx). */
export const DEFAULT_VAT_PERCENT = 15;

type Problem = { ok: false; error: string; errorAr: string; field: string };
type Db = { systemConfig: { findUnique(args: { where: { id: string } }): Promise<unknown> } };
type Num = { toString(): string } | null | undefined;

export type InventorySettings = {
  /** What the owner stored ("25.5"), or null. */
  lowStockGreenKg: string | null;
  /** The line in force: the stored value, else the built-in 20. */
  effectiveLowStockGreenKg: string;
  isDefault: boolean;
};

export type InvoicingSettings = {
  defaultVatPercent: string | null;
  effectiveDefaultVatPercent: string;
  isDefault: boolean;
};

const plain = (v: Num): string | null => (v === null || v === undefined ? null : new Decimal(v.toString()).toString());

export function inventoryFromRow(row: { inventoryLowStockGreenKg?: Num } | null | undefined): InventorySettings {
  const stored = plain(row?.inventoryLowStockGreenKg);
  return { lowStockGreenKg: stored, effectiveLowStockGreenKg: stored ?? String(LOW_STOCK_GREEN_KG_DEFAULT), isDefault: stored === null };
}

export function invoicingFromRow(row: { invoiceDefaultVatPercent?: Num } | null | undefined): InvoicingSettings {
  const stored = plain(row?.invoiceDefaultVatPercent);
  return { defaultVatPercent: stored, effectiveDefaultVatPercent: stored ?? String(DEFAULT_VAT_PERCENT), isDefault: stored === null };
}

export async function readInventorySettings(db: Db): Promise<InventorySettings> {
  return inventoryFromRow((await db.systemConfig.findUnique({ where: { id: "singleton" } })) as { inventoryLowStockGreenKg?: Num } | null);
}

export async function readInvoicingSettings(db: Db): Promise<InvoicingSettings> {
  return invoicingFromRow((await db.systemConfig.findUnique({ where: { id: "singleton" } })) as { invoiceDefaultVatPercent?: Num } | null);
}

/** Arabic-Indic and Persian digits, the Arabic decimal separator and stray spaces → a plain number. */
export function normaliseNumberText(v: string): string {
  return v
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/[\s ‎‏]/g, "");
}

function decimalOf(v: unknown): Decimal | null {
  if (typeof v === "number") return Number.isFinite(v) ? new Decimal(v) : null;
  if (typeof v !== "string") return null;
  const t = normaliseNumberText(v);
  return /^\d+(\.\d+)?$/.test(t) ? parseFiniteDecimal(t) : null;
}

/** PUT /api/settings/inventory body → the column to write (absent key = nothing to change). */
export function parseInventoryPatch(b: Record<string, unknown>): { ok: true; data: { inventoryLowStockGreenKg?: Decimal | null } } | Problem {
  const data: { inventoryLowStockGreenKg?: Decimal | null } = {};
  if ("lowStockGreenKg" in b) {
    const v = b.lowStockGreenKg;
    if (v === null || v === "") data.inventoryLowStockGreenKg = null;
    else {
      const d = decimalOf(v);
      if (!d || !d.greaterThan(0) || d.greaterThan(LOW_STOCK_GREEN_KG_MAX) || d.decimalPlaces() > 3) {
        return {
          ok: false, field: "lowStockGreenKg",
          error: `The low-stock line is a weight in kg greater than 0 and at most ${LOW_STOCK_GREEN_KG_MAX.toLocaleString("en")}, with at most three decimals.`,
          errorAr: `حد المخزون المنخفض وزن بالكيلوغرام أكبر من صفر وحتى ${LOW_STOCK_GREEN_KG_MAX.toLocaleString("en")}، بثلاث منازل عشرية على الأكثر.`,
        };
      }
      data.inventoryLowStockGreenKg = d;
    }
  }
  return { ok: true, data };
}

/** PUT /api/settings/invoicing body → the column to write. */
export function parseInvoicingPatch(b: Record<string, unknown>): { ok: true; data: { invoiceDefaultVatPercent?: Decimal | null } } | Problem {
  const data: { invoiceDefaultVatPercent?: Decimal | null } = {};
  if ("defaultVatPercent" in b) {
    const v = b.defaultVatPercent;
    if (v === null || v === "") data.invoiceDefaultVatPercent = null;
    else {
      const d = decimalOf(v);
      if (!d || d.isNegative() || d.greaterThan(100) || d.decimalPlaces() > 2) {
        return {
          ok: false, field: "defaultVatPercent",
          error: "The default VAT is a percentage from 0 to 100, with at most two decimals.",
          errorAr: "نسبة الضريبة الافتراضية من 0 إلى 100، بمنزلتين عشريتين على الأكثر.",
        };
      }
      data.invoiceDefaultVatPercent = d;
    }
  }
  return { ok: true, data };
}
