"use client";

// A fixed asset: sources, capitalisation, depreciation, disposal (Figma ACC-61, ACC-63).
import { use } from "react";
import { AssetDetail } from "../_asset";

export default function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AssetDetail id={id} />;
}
