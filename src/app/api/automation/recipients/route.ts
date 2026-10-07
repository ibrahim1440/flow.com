import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { formatPhone, normalizePhoneForWhatsApp } from "@/lib/automation/phone";

/**
 * Active employees, for the "a specific employee" recipient picker. Whether each has a usable
 * WhatsApp number is shown so a rule is not built around someone who cannot receive it; the
 * number itself is shown masked.
 */
export async function GET() {
  const { error } = await requireModule("automation");
  if (error) return error;

  const employees = await prisma.employee.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, phoneNumber: true },
  });
  return NextResponse.json({
    employees: employees.map((e) => {
      const p = normalizePhoneForWhatsApp(e.phoneNumber);
      return {
        id: e.id,
        name: e.name,
        hasPhone: p.ok,
        phoneHint: p.ok ? formatPhone(p.phone).replace(/\d(?=(?:\D*\d){4})/g, "•") : null,
      };
    }),
  });
}
