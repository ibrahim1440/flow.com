// A category refusal (src/lib/inventory/item-categories.ts) as an API response: English, Arabic and a stable code.
import { NextResponse } from "@/lib/api-response";
import type { Refusal } from "./item-categories";

export const refusal = (r: Refusal) => NextResponse.json({ error: r.error, errorAr: r.errorAr, code: r.code }, { status: r.status });
