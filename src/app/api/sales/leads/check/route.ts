import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireSub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { findDuplicateCandidates, normalizePhone } from "@/lib/services/sales/leads";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";

/** Gate E2: at most 30 checks a minute per person — a check names matches, so it is not a free probing tool. */
const LEAD_CHECK_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/**
 * POST /api/sales/leads/check `{ companyName, phone? }` — P2 ERR-07 (owner decision ب1): BEFORE a lead is saved, the
 * form asks whether the business is already there, so the rep can open the existing record instead of adding it twice.
 * Nothing is written. Read-only, the lead writers' (sales › lead_write).
 *
 *   leads      the open leads with the same phone (last 9 digits) or the same business name (normalised) — a lead the
 *              caller neither owns nor sees is reported by its match only (P0 SEC-06: no id, no name)
 *   customers  the customers with the same phone or the same name: in the caller's book (customerInScope) by id and
 *              name («افتحه»); anyone else's as `{ id: null, name: null, colleague: true }` («مسجّلة عند زميل»)
 *
 * The answer never blocks: saving stays the caller's choice (the save route keeps its own phone check).
 * Rate-limited per user (gate E2): 30 a minute → 429 TOO_MANY_CHECKS with Retry-After.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("sales", "lead_write");
  if (error) return error;
  let b: Record<string, unknown> = {};
  try { b = ((await request.json()) ?? {}) as Record<string, unknown>; } catch { /* empty body: refused below */ }
  const companyName = typeof b.companyName === "string" ? b.companyName.trim().slice(0, 200) : "";
  const phone = typeof b.phone === "string" ? b.phone.trim().slice(0, 40) : "";
  const rl = await checkAndRecordRateLimit({ scope: "sales.lead-check", key: user.id, ...LEAD_CHECK_LIMIT });
  if (rl.limited) {
    return NextResponse.json({ error: "تجاوزت حد الفحص، حاول بعد دقيقة", errorEn: "Too many checks in a minute — wait a moment and try again.", code: "TOO_MANY_CHECKS" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (companyName.length < 2 && !phone) {
    return NextResponse.json({ error: "اكتب اسم المنشأة أو الجوال.", errorEn: "Send a company name or a phone.", code: "NOTHING_TO_CHECK" }, { status: 400 });
  }
  try {
    const leads = companyName.length >= 2 || phone
      ? await findDuplicateCandidates(prisma, { companyName: companyName.length >= 2 ? companyName : "", phone: phone || null }, user)
      : [];
    const key = normalizePhone(phone);
    const byPhone = key
      ? await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Customer"
           WHERE "phone" IS NOT NULL AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ${key} LIMIT 5`
      : [];
    const byName = companyName.length >= 2
      ? await prisma.customer.findMany({
          where: { OR: [{ name: { equals: companyName, mode: "insensitive" } }, { nameAr: { equals: companyName, mode: "insensitive" } }] },
          select: { id: true }, take: 5,
        })
      : [];
    const ids = [...new Set([...byPhone.map((r) => r.id), ...byName.map((r) => r.id)])];
    const rows = ids.length ? await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, nameAr: true, phone: true } }) : [];
    const customers = await Promise.all(rows.map(async (c) => {
      const matchedOn = [...(byPhone.some((r) => r.id === c.id) ? ["phone" as const] : []), ...(byName.some((r) => r.id === c.id) ? ["company" as const] : [])];
      return (await customerInScope(user, c.id))
        ? { id: c.id, name: c.nameAr || c.name, matchedOn, colleague: false }
        : { id: null, name: null, matchedOn, colleague: true };
    }));
    return NextResponse.json({ leads, customers, found: leads.length + customers.length > 0 });
  } catch (err) {
    return handleDomainError(err);
  }
}
