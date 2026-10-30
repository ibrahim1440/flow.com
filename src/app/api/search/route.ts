import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { searchRecords } from "@/lib/services/search/records";

/**
 * GET /api/search?q= — Ctrl K record search (batch 24 WP-A): customers, deals, quotations and leads the
 * caller may open, in groups of at most `limit` (default 6). The scope is the session's, decided in
 * services/search/records.ts; no query parameter widens it. A group the caller has no module for is empty.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 120);
  const limit = Number(url.searchParams.get("limit") ?? 6) || 6;
  try {
    const result = await searchRecords(prisma, { id: user.id, role: user.role, permissions: user.permissions }, q, { limit });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleDomainError(err);
  }
}
