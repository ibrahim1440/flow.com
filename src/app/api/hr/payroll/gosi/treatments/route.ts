import { hrHandler } from "@/lib/hr/http";
import { listGosiTreatments } from "@/lib/hr/services/gosi";

// P-2 rev3 item 3: the D-4h GOSI difference matrix (every case disabled until the accountant decides).
export const GET = hrHandler(async ({ actor }) => listGosiTreatments(actor));
