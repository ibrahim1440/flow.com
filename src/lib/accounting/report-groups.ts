// Accounting A5 — the statement lines an account belongs to (Account.reportGroup; NULL = inferred). Pure: safe in
// client components (the chart editor) as well as on the server (./statements.ts).
export const REPORT_GROUPS = ["CURRENT_ASSET", "NON_CURRENT_ASSET", "CURRENT_LIABILITY", "NON_CURRENT_LIABILITY", "EQUITY", "REVENUE", "COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_INCOME_EXPENSE", "ZAKAT"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];
export const isReportGroup = (v: unknown): v is ReportGroup => typeof v === "string" && (REPORT_GROUPS as readonly string[]).includes(v);

export const GROUP_LABEL: Record<ReportGroup, [string, string]> = {
  CURRENT_ASSET: ["الأصول المتداولة", "Current assets"],
  NON_CURRENT_ASSET: ["الأصول غير المتداولة", "Non-current assets"],
  CURRENT_LIABILITY: ["الالتزامات المتداولة", "Current liabilities"],
  NON_CURRENT_LIABILITY: ["الالتزامات غير المتداولة", "Non-current liabilities"],
  EQUITY: ["حقوق الملكية", "Equity"],
  REVENUE: ["الإيرادات", "Revenue"],
  COST_OF_SALES: ["تكلفة المبيعات", "Cost of sales"],
  OPERATING_EXPENSE: ["المصروفات التشغيلية", "Operating expenses"],
  OTHER_INCOME_EXPENSE: ["إيرادات ومصروفات أخرى وتمويلية", "Other income / finance costs"],
  ZAKAT: ["الزكاة", "Zakat"],
};

