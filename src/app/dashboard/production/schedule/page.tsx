"use client";
// Production › «جدول التحميص» (Figma 377:2 RM6–RM8; ROASTERS.md §2 D2): the day (RM6), the roasters and
// week (RM8) and batch planning (RM7), inside the approved Phase 4 shell. ?view=day|roasters|plan,
// ?date=YYYY-MM-DD (day), ?product=<coffee> (plan). The roast queue stays on /dashboard/production.
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { OpsRoot } from "@/components/ops/ui";
import { useD21Title } from "@/components/shell/page-context";
import { useI18n } from "@/lib/i18n/context";
import { DayView } from "./_parts/day";
import { PlanView } from "./_parts/plan";
import { RoastersView } from "./_parts/roasters";

function Schedule() {
  const { t } = useI18n();
  const sp = useSearchParams();
  const v = sp.get("view");
  const view = v === "plan" || v === "roasters" ? v : "day";
  useD21Title(view === "plan" ? t("schedViewPlan") : view === "roasters" ? t("schedViewRoasters") : null);
  if (view === "plan") return <PlanView key={`p${sp.get("product") ?? ""}`} initialProduct={sp.get("product")} />;
  if (view === "roasters") return <RoastersView />;
  return <DayView key={`d${sp.get("date") ?? ""}${sp.get("approved") ?? ""}`} initialDay={sp.get("date")} approved={sp.get("approved")} />;
}

export default function SchedulePage() {
  return (
    <OpsRoot>
      <Suspense fallback={null}>
        <Schedule />
      </Suspense>
    </OpsRoot>
  );
}
