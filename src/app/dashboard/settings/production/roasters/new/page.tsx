"use client";
// RM2 «إضافة محمصة» (Figma 389:640 at 1440, 390:849 at 1024, phone 379:49). POST
// /api/settings/production/roasters; on success, back to the list.
import { useRouter, useSearchParams } from "next/navigation";
import { OpsLoading, OpsRoot, PageHeader } from "@/components/ops/ui";
import { useD21Phone, useD21Title } from "@/components/shell/page-context";
import { SettingsFrame } from "../../../../_components/tools-ui";
import { BASE, ReadOnlyNote, Retry, useLang, useOverview } from "../../_parts/shared";
import { emptyDraft, RoasterForm } from "../../_parts/form";

export default function AddRoasterPage() {
  const { L } = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const { data, error, reload } = useOverview();
  const type = params.get("type") === "SAMPLE" ? "SAMPLE" : "PRODUCTION";
  useD21Title(L("إضافة محمصة", "Add roaster"));
  useD21Phone({ title: L("إضافة محمصة", "Add roaster"), sub: L("الإعدادات · المحامص", "Settings · Roasters"), back: BASE, ownBar: true });

  const others = { PRODUCTION: data?.roasters.filter((r) => r.type === "PRODUCTION").length ?? 0, SAMPLE: data?.roasters.filter((r) => r.type === "SAMPLE").length ?? 0 };
  return (
    <OpsRoot className="tl-root">
      <SettingsFrame>
        <PageHeader title={L("إضافة محمصة", "Add roaster")} />
        <p className="tl-sub">{L("الإعدادات · الإنتاج والتحميص · المحامص", "Settings · Production & roasting · Roasters")}</p>
        {error ? <Retry error={error} onRetry={reload} /> : !data ? <OpsLoading rows={6} /> : !data.can.edit ? <ReadOnlyNote /> : (
          <RoasterForm
            mode="add"
            initial={emptyDraft(type)}
            people={data.people}
            othersOfType={others}
            onSaved={() => router.push(BASE)}
          />
        )}
      </SettingsFrame>
    </OpsRoot>
  );
}
