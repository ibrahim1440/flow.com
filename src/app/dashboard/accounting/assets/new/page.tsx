"use client";

// Register a fixed asset (Figma ACC-61, draft state).
import { Card, CardTitle, NoPermission, useL } from "../../../finance/_components/ui";
import { useCan } from "../../_components/kit";
import { AssetEditor } from "../_asset";

export default function NewAssetPage() {
  const { L } = useL();
  const { can } = useCan();
  if (!can("fa_prepare")) return <NoPermission />;
  return (
    <Card>
      <CardTitle title={L("أصل ثابت جديد", "New fixed asset")} sub={L("يُسجَّل كمسودة، ثم يُقدَّم ويعتمده ويُرسمله شخص آخر · بيانات تجريبية في البيئة المحلية", "Registered as a draft, then submitted, approved and capitalised by someone else · synthetic data locally")} />
      <AssetEditor />
    </Card>
  );
}
