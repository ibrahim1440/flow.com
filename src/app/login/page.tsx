import { redirect } from "next/navigation";
import { getUserWithPermissions } from "@/lib/auth-server";
import { homeIsMyDayOnly } from "@/lib/workspace/landing";
import LoginClient from "./login-client";

/**
 * /login. Someone already signed in (a live ERP session) is sent to their home instead of the sign-in form — «يومي» for a
 * sales rep, otherwise /dashboard, which takes them to their usual landing (D16 gate, «أبو فهد»). Not redirected: a station
 * sign-in (`?next=/station/…`) or a station's idle sign-out (`?reason=`), an account that must first enroll its second
 * factor or set its own password (those flows live on their own screens), and anyone without a live session — logout and
 * an expired session end the session first, so they always reach the form.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  if (!sp.next && !sp.reason) {
    const user = await getUserWithPermissions().catch(() => null);
    if (user && !user.mfaEnrollmentRequired && !user.passwordChangeRequired) {
      redirect(homeIsMyDayOnly({ role: user.role, permissions: user.permissions }) ? "/dashboard/my-day" : "/dashboard");
    }
  }
  return <LoginClient />;
}
