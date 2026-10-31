// «استيراد البيانات من Excel / قيود» — who may use it (pure: shared by the API gate, the pages and the menu tests).
//   · the admin role — unchanged: reads and previews freely, the import is the admin-role gate with a step-up;
//   · a holder of accounting › data_import (with the accounting module) — the owner grants it to the accountant. The
//     accounting module is privileged, so the holder acts as a verified individual on every request, and the import
//     itself also needs a recent step-up (like the opening balances);
//   · anyone else: 403.
// The server gate that applies this is ./gate.ts (requireDataImport); the routes call nothing else.
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

export const DATA_IMPORT_MODULE = "accounting";
export const DATA_IMPORT_SUB = "data_import";

export type DataImportActor = "admin" | "holder";

/** The caller's footing on the import, or null when they may not use it at all. */
export function dataImportActor(u: { role: string; permissions: Permissions } | null | undefined): DataImportActor | null {
  if (!u) return null;
  if (u.role === "admin") return "admin";
  return hasModuleAccess(u.permissions, DATA_IMPORT_MODULE) && hasSubPrivilege(u.permissions, DATA_IMPORT_MODULE, DATA_IMPORT_SUB) ? "holder" : null;
}

/**
 * The gate a request takes: none (an admin reading or previewing), the admin-role gate with a step-up (an admin
 * importing), the privileged gate of accounting.data_import — identity, and a step-up when importing (a holder) — or a
 * refusal. `apply` is the import itself (a write); everything else (counts, template, preview) writes nothing.
 */
export type DataImportGate =
  | { kind: "forbidden" }
  | { kind: "none" }
  | { kind: "admin"; stepUp: true }
  | { kind: "holder"; stepUp: boolean };

export function dataImportGate(u: { role: string; permissions: Permissions } | null | undefined, apply: boolean): DataImportGate {
  const actor = dataImportActor(u);
  if (!actor) return { kind: "forbidden" };
  if (actor === "admin") return apply ? { kind: "admin", stepUp: true } : { kind: "none" };
  return { kind: "holder", stepUp: apply };
}
