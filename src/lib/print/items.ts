/** Print job item references, shared by the client (layout, preview) and the server (audit). */
export type OriginItemIn = { kind: "product"; productId: string; batchId?: string | null; lotId?: string | null; copies: number };
export type CupItemIn = { kind: "cup"; sessionId: string; cupId: string | null; copies: number };
/** A green-coffee lot: `sackNo` 1…N prints «كيس n من N» (one label per sack); null prints the lot label. */
export type GreenItemIn = { kind: "green"; greenBeanId: string; sackNo: number | null; copies: number };
export type MaterialItemIn = { kind: "material"; materialId: string; copies: number };
export type ItemIn = OriginItemIn | CupItemIn | GreenItemIn | MaterialItemIn;

export const itemRef = (it: ItemIn) =>
  it.kind === "product" ? `p:${it.productId}|b:${it.batchId ?? ""}|l:${it.lotId ?? ""}`
    : it.kind === "cup" ? `c:${it.sessionId}:${it.cupId ?? "-"}`
    : it.kind === "green" ? `g:${it.greenBeanId}:${it.sackNo ?? "-"}`
    : `m:${it.materialId}`;
