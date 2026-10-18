/** Print job item references, shared by the client (layout, preview) and the server (audit). */
export type OriginItemIn = { kind: "product"; productId: string; batchId?: string | null; lotId?: string | null; copies: number };
export type CupItemIn = { kind: "cup"; sessionId: string; cupId: string | null; copies: number };
export type ItemIn = OriginItemIn | CupItemIn;

export const itemRef = (it: ItemIn) =>
  it.kind === "product" ? `p:${it.productId}|b:${it.batchId ?? ""}|l:${it.lotId ?? ""}` : `c:${it.sessionId}:${it.cupId ?? "-"}`;
