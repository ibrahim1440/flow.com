import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth-server";

export default async function Home() {
  const user = await getUser();
  if (user) redirect("/dashboard");
  redirect("/login");
}
