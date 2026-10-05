// Inventory account and loss rules shared by the service and the journal translator.
import type { InvItemKind, InvIssueReason } from "@/generated/prisma/client";

/** Kinds whose quantity can turn into output weight in production (packaging does not). */
export const YIELDING: ReadonlySet<InvItemKind> = new Set(["GREEN_COFFEE", "ROASTED_COFFEE", "MILK", "BAKERY_INGREDIENT", "FINISHED_GOOD"]);
export const KIND_ROLE: Record<InvItemKind, string> = {
  GREEN_COFFEE: "INVENTORY_RAW", MILK: "INVENTORY_RAW", BAKERY_INGREDIENT: "INVENTORY_RAW",
  PACKAGING: "INVENTORY_PACKAGING", CONSUMABLE: "INVENTORY_PACKAGING",
  ROASTED_COFFEE: "INVENTORY_WIP", FINISHED_GOOD: "INVENTORY_FINISHED", RESALE_GOOD: "INVENTORY_RESALE",
};
export const ISSUE_ROLE: Record<InvIssueReason, string> = {
  INTERNAL_USE: "COGS", CALIBRATION: "WASTE_CALIBRATION", QC: "WASTE_QC", TRAINING: "WASTE_TRAINING", SPOILAGE: "INVENTORY_VARIANCE",
};

