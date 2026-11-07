import { cookies } from "next/headers";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { STATION_SESSION_COOKIE } from "@/lib/station/device";
import { DEVICE_REQUIRED, DEVICE_REVOKED, currentDevice, stationPolicy, stationSessionFor } from "@/lib/services/station/guard";
import { clearSessionCookie } from "@/lib/services/station/session";

/**
 * POST /api/station/language {preferredLanguage: "ar" | "en"} — the station bar's language switch on a paired device (the
 * owner's decision: every station screen in both languages, switchable at any time). Saved to the signed-in employee's
 * own profile preference — the same column the ERP profile saves — so it follows them to any station and the ERP.
 * A personal session saves through PATCH /api/profile as in the ERP.
 */
export async function POST(request: Request) {
  const dev = await currentDevice();
  if (dev.state === "none" || dev.state === "unknown") return DEVICE_REQUIRED().response();
  if (dev.state === "revoked") return clearSessionCookie(DEVICE_REVOKED().response());
  const raw = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const lang = raw.preferredLanguage === "en" ? "en" : raw.preferredLanguage === "ar" ? "ar" : null;
  if (!lang) return NextResponse.json({ error: "اللغة غير معروفة.", errorEn: "Unknown language.", code: "LANGUAGE_INVALID" }, { status: 400 });
  const jar = await cookies();
  const live = await stationSessionFor(dev.device, jar.get(STATION_SESSION_COOKIE)?.value ?? null, { touch: true, policy: await stationPolicy() });
  if (!live) return NextResponse.json({ error: "انتهت جلسة المحطة.", errorEn: "The station session has ended.", code: "STATION_SESSION_REQUIRED" }, { status: 401 });
  await prisma.employee.update({ where: { id: live.employee.id }, data: { preferredLanguage: lang } });
  return NextResponse.json({ preferredLanguage: lang }, { headers: { "Cache-Control": "no-store" } });
}
