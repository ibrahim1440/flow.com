import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAdminAction, requireAuth, requirePrivilegedAction } from "@/lib/auth-server";
import { bookArchiveWhere, logScopeFor } from "@/lib/automation/log-scope";
import type { Prisma } from "@/generated/prisma/client";
import { foldArabic } from "@/lib/services/search/normalize";
import { archivePdf } from "@/lib/automation/archive-pdf";
import { customerInScope } from "@/lib/services/sales/customer-access";
import { companyInfoFrom } from "@/lib/notify/templates/demo";
import { sellerSnapshot } from "@/lib/services/invoicing/settings";

const PER_PAGE = 50;
const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00+03:00`) : null);

/**
 * «الأرشيف» (batch 25): message bodies older than 180 days, for legal claims. The ADMIN role only, after a recent
 * step-up (it reads what customers were sent). Search: customer (id or name), date range (Riyadh days, by when the
 * message was created), subject; channel. Read-only — the archive cannot be changed or deleted (database trigger).
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  // The administrator: the whole archive. Fix round 2: a manager reads the messages to customers, a rep those to the
  // customers of their book — each after a recent step-up, as a verified individual (it shows what customers were sent).
  const admin = user.role === "admin";
  const scope = admin ? null : await logScopeFor(user);
  if (!admin && !scope) return forbidden("الأرشيف لمدير النظام ومن يتابع رسائل العملاء.");
  const refused = admin
    ? await requireAdminAction(user, "automation.archive", { stepUp: true, message: "الأرشيف لمدير النظام فقط." })
    : await requirePrivilegedAction(user, "automation.archive_read", { stepUp: true });
  if (refused) return refused;

  const url = new URL(request.url);
  const customer = (url.searchParams.get("customer") ?? "").trim().slice(0, 80);
  const subject = (url.searchParams.get("subject") ?? "").trim().slice(0, 120);
  const channel = url.searchParams.get("channel");
  const from = day(url.searchParams.get("from"));
  const to = day(url.searchParams.get("to"));
  const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
  // ?all=1: up to 2,000 rows at once, for the CSV export of a search (fix round 1).
  const all = url.searchParams.get("all") === "1";

  const where: Prisma.MessageArchiveWhereInput = {
    // Fix round 3 (gate D3): a rep's archive rows are scoped by what each message is about, like the log.
    AND: [!scope ? {} : scope.kind === "book" ? bookArchiveWhere(scope) : { customerId: { not: null } }],
  };
  if (channel === "whatsapp" || channel === "email") where.channel = channel;
  if (subject) where.subject = { contains: subject, mode: "insensitive" };
  if (from || to) where.messageCreatedAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) };
  let truncated = false;
  if (customer) {
    // Arabic folded (ة/ه, ى/ي, hamza, diacritics): «مقهى السدره» finds «مقهى السدرة».
    const f = foldArabic(customer);
    const everyone = await prisma.customer.findMany({ select: { id: true, name: true, nameAr: true }, take: 20_000 });
    const ids = everyone.filter((c) => c.id === customer || foldArabic(c.name).includes(f) || (c.nameAr ? foldArabic(c.nameAr).includes(f) : false)).map((c) => c.id);
    truncated = ids.length > 1000;
    where.OR = [{ customerId: { in: ids.slice(0, 1000) } }, { recipientName: { contains: customer, mode: "insensitive" } }];
  }
  // ?format=pdf&customerId=<id> (batch 25b): one customer's archived messages as a PDF — the same scope and filters.
  const pdfFor = url.searchParams.get("format") === "pdf" ? (url.searchParams.get("customerId") ?? "").trim().slice(0, 64) : null;
  if (pdfFor !== null) {
    if (!pdfFor) return NextResponse.json({ error: "اختر العميل أول.", errorEn: "customerId is required." }, { status: 400 });
    const c = await prisma.customer.findUnique({ where: { id: pdfFor }, select: { id: true, name: true, nameAr: true } });
    // Gate D5: a customer outside the viewer's book is answered like a missing one — not even its name in a header.
    if (!c || (!admin && !(await customerInScope(user, pdfFor)))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const pdfWhere: Prisma.MessageArchiveWhereInput = { AND: [where, { customerId: pdfFor }] };
    const rows = await prisma.messageArchive.findMany({ where: pdfWhere, orderBy: { messageCreatedAt: "asc" }, take: 2001 });
    const company = companyInfoFrom(await sellerSnapshot(prisma));
    const pdf = archivePdf({ customerName: c.nameAr || c.name, customerId: c.id, rows: rows.slice(0, 2000), truncated: rows.length > 2000, exportedBy: user.name ?? user.id, now: new Date(), company: company.nameAr || null });
    return new Response(new Uint8Array(pdf), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="archive-${c.id}.pdf"`, "Cache-Control": "no-store" } });
  }
  const take = all ? 2000 : PER_PAGE;
  const [rows, total] = await Promise.all([
    prisma.messageArchive.findMany({ where, orderBy: { messageCreatedAt: "desc" }, skip: all ? 0 : (page - 1) * PER_PAGE, take }),
    prisma.messageArchive.count({ where }),
  ]);
  const names = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, nameAr: true } })).map((c) => [c.id, c.nameAr || c.name]));
  return NextResponse.json({ rows: rows.map((r) => ({ ...r, customerName: r.customerId ? names.get(r.customerId) ?? null : null })), total, page, perPage: PER_PAGE, truncated });
}
