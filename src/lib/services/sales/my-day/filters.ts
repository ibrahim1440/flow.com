// «كلّمهم اليوم» — the full list's filter chips (batch 24 council fix round 2, item 7): الكل / متأخرين / متوقع قريبًا /
// عيّنات / متابعات. Pure; shared by the page and the tests. A «كلّمته — بانتظار الطلب» row (CALLED) is a late customer.
export type CallFilter = "ALL" | "LATE" | "EXPECTED" | "SAMPLE" | "FOLLOW_UP";

export function callFilterOf(item: { reason: { code: string } }): Exclude<CallFilter, "ALL"> | null {
  switch (item.reason.code) {
    case "LATE": case "CALLED": return "LATE";
    case "DUE": case "EXPECTED": return "EXPECTED";
    case "SAMPLE": return "SAMPLE";
    case "FOLLOW_UP": return "FOLLOW_UP";
    default: return null;
  }
}

export function filterCallList<T extends { reason: { code: string } }>(list: T[], f: CallFilter): T[] {
  return f === "ALL" ? list : list.filter((i) => callFilterOf(i) === f);
}
