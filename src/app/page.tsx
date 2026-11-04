import { redirect } from "next/navigation";
import { getUserWithPermissions } from "@/lib/auth-server";
import { homeIsMyDayOnly } from "@/lib/workspace/landing";

export default async function Home() {
  const user = await getUserWithPermissions();
  // A sales rep opens on «يومي» (owner, 4 Nov 2026); everyone else as before.
  if (user) redirect(homeIsMyDayOnly(user) ? "/dashboard/my-day" : "/dashboard");
  redirect("/login");
}
