"use client";
/** «إعدادات الطباعة / Print settings» (design §P2-3): two tabs, Templates & fields and Paper & printer profiles. */
import { useRouter } from "next/navigation";
import { Tabs } from "@/components/hr/ui";
import { useL } from "@/components/ops/ui";

export function PrintSettingsTabs({ current }: { current: "templates" | "profiles" }) {
  const L = useL();
  const router = useRouter();
  return (
    <Tabs label={L("إعدادات الطباعة", "Print settings")} value={current}
      onChange={(k) => router.push(k === "templates" ? "/dashboard/labels/templates" : "/dashboard/labels/profiles")}
      items={[{ key: "templates", label: L("القوالب والحقول", "Templates & fields") }, { key: "profiles", label: L("ملفات الورق والطابعة", "Paper & printer profiles") }]} />
  );
}
