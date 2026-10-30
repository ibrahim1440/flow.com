import type { CreditState } from "@/components/credit/credit-ui";
// The shape of GET /api/customers/[id]/account (src/app/api/customers/[id]/account/route.ts),
// as the account page reads it. Dates arrive as ISO strings, money as fixed-point strings.

export type Contact = { id: string; name: string; role: string | null; phone: string | null; email: string | null; position: number };

export type RoastPreference = {
  id: string; greenBeanId: string; profileName: string; usageType: "ESPRESSO" | "FILTER" | "BOTH"; notes: string | null;
  greenBean: { id: string; beanType: string; serialNumber: string };
  targetColorWhole: number | null; targetToleranceWhole: number | null;
  targetColorGround: number | null; targetToleranceGround: number | null;
  targetDeltaMin: number | null; targetDeltaMax: number | null;
};

export type Customer = {
  id: string; name: string; nameAr: string | null; phone: string | null; email: string | null; address: string | null;
  whatsappOptOut: boolean; createdAt: string;
  commercialRegNo: string | null; vatNumber: string | null; segment: string | null; city: string | null; priceList: string | null;
  paymentTermsDays: number | null; creditLimit: string | null;
  /** «مدة الإيقاف الافتراضية» (feat/credit-hold), days; null = not set. */
  defaultHoldDays?: number | null;
  accountOwner: { id: string; name: string } | null;
  contacts: Contact[];
  roastPreferences: RoastPreference[];
  _count: { orders: number; roastPreferences: number };
};

export type Stage = { id: string; code: string; nameEn: string; nameAr: string; position: number; /** Absent on a deal's own stage; false for a hidden stage (history labels only). */ isActive?: boolean };

export type Activity = {
  id: string; type: string; subject: string; body: string | null; outcome: string | null;
  dueAt: string | null; completedAt: string | null; createdAt: string;
  owner: { id: string; name: string }; opportunity: { id: string; title: string } | null; mine?: boolean;
};

export type Deal = {
  id: string; title: string; outcome: "OPEN" | "WON" | "LOST"; amount: string; currency: string; probability: number;
  expectedCloseAt: string | null; createdAt: string; closedAt: string | null; lostReason: string | null;
  stage: Stage; owner: { id: string; name: string } | null; _count: { quotes: number; samples: number };
};

export type OpenDeal = Deal & {
  updatedAt: string;
  stageEvents: { id: string; fromStageId: string | null; toStageId: string | null; createdAt: string }[];
  nextStep: Activity | null;
};

export type Quote = {
  id: string; quoteNumber: string; revision: number; status: string; currency: string; validUntil: string | null;
  grandTotal: string; taxTotal: string; issuedAt: string | null; acceptedAt: string | null; createdAt: string;
  opportunity: { id: string; title: string };
};

export type Sample = {
  id: string; description: string | null; quantity: string; unit: string; status: string; sentAt: string | null;
  feedbackScore: number | null; createdAt: string;
  productSku: { name: string | null; nameAr?: string | null; skuCode: string } | null; opportunity: { id: string; title: string };
};

export type Order = {
  id: string; orderNumber: number; createdAt: string; status: string; approvalStatus: string; paymentStatus: string;
  vatInvoiceStatus: string; quotationNumber: string | null; itemCount: number; totalKg: number;
  /** The orders board's computed stage (services/orders/pipeline.ts); null for cancelled / rejected. */
  pipeline: { key: string; stage: number; partDelivered: boolean } | null;
};

/** A document on the customer's file («الملفات»). Metadata only. */
export type CustomerFile = {
  id: string; category: string; title: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string;
  uploadedBy: { id: string; name: string } | null;
  /** «صلاحية العقد» (batch 24 WP-C): contracts and price agreements only; date-only ISO strings. */
  validFrom?: string | null; validUntil?: string | null; renewalNoticeDays?: number | null;
};

/** «كشف الحساب»: derived from accepted quotations and approved collections — not an accounting ledger. */
export type StatementLine = {
  kind: "document" | "payment"; key: string; at: string; opportunityId: string; dealTitle: string;
  debit: string; credit: string; balance: string;
  quoteId?: string; quoteNumber?: string; revision?: number;
  paymentId?: string; method?: string; orderNumber?: number | null; reference?: string | null;
};
export type AgingKey = "notDue" | "d1_30" | "d31_60" | "d61_90" | "d90plus";
export type Statement = {
  termsDays: number | null;
  lines: StatementLine[];
  totals: { debit: string; credit: string; net: string; outstanding: string; unapplied: string };
  open: { opportunityId: string; dealTitle: string; quoteId: string; quoteNumber: string; total: string; paid: string; unpaid: string; dueAt: string; basis: "delivery" | "acceptance"; daysOverdue: number; bucket: AgingKey }[];
  aging: Record<AgingKey | "total", string>;
  currency: string;
};
export type Credit =
  | { scope: "all"; limit: string; used: string; available: string; percent: number | null; over: boolean }
  | { scope: "own"; limit: string; used: null; available: null; percent: null; over: null };

export type Collection = {
  id: string; status: string; amountGross: string; currency: string; paymentMethod: string; collectedAt: string;
  referenceNumber: string | null; order: { id: string; orderNumber: number } | null; opportunity: { id: string; title: string };
};

export type TimelineEntry = { key: string; at: string; kind: string } & (
  | { kind: "activity"; activity: Activity }
  | { kind: "sample"; sample: { id: string; name: string | null; nameAr?: string | null; quantity: string; unit: string; deal: { id: string; title: string } } }
  | { kind: "quote_issued" | "quote_accepted"; quote: { id: string; quoteNumber: string; revision: number; grandTotal: string; currency: string }; stageMove?: { from: string; to: string } | null }
  | { kind: "order"; order: { id: string; orderNumber: number; totalKg: number; status: string; value: string | null } }
  | { kind: "payment"; payment: { id: string; amount: string; currency: string; method: string; orderNumber: number | null } }
  // Phase D: a delivery, with the lots the server drew it from (batch numbers only).
  // feat/credit-hold: the customer's credit log (grace, hold, lift, automatic lift).
  | { kind: "credit"; credit: { id: string; kind: "GRACE" | "HOLD" | "LIFT" | "AUTO_LIFT"; days: number | null; untilAt: string | null; reason: string | null; by: { id: string; name: string } | null; liftKind: string | null; untilPaid: boolean } }
  | { kind: "delivery"; delivery: { id: string; orderNumber: number; item: string; units: number | null; kg: number; type: string; lots: string[] } }
);

export type Account = {
  customer: Customer;
  source: { leadId: string; convertedAt: string; source: string; sourceNote: string | null } | null;
  sections: { sales: boolean; orders: boolean; scope: "all" | "own" | null; files: boolean };
  metrics: {
    sales12m: { net: string; previousNet: string; changePercent: number | null; documents: number; currency: string } | null;
    balance: {
      outstanding: string; documents: number; openDocuments: number; currency: string;
      /** «عروض مقبولة لم تُفوتر»: `outstanding` is accepted quotations less approved collections. */
      basis?: "ACCEPTED_NOT_INVOICED";
      /** The balance owed from the receivables ledger, once the customer has an issued invoice. */
      ar?: { outstanding: string; basis: "RECEIVABLES" } | null;
      lastPayment: { amount: string; collectedAt: string; method: string; orderNumber: number | null } | null;
    } | null;
    lastOrder: { id: string; orderNumber: number; createdAt: string; daysAgo: number } | null;
    cadenceDays: number | null;
    /** THE monthly kilograms: last 90 days ÷ 3 (aggregates.monthlyKg), the tier's and «يومي»'s figure. */
    kgPerMonth?: number | null;
    monthly: { month: string; kg: number; partial?: true }[] | null;
    usualItems: { name: string; nameAr: string | null; kgPerMonth: number }[] | null;
    unpricedOrders: number | null;
    /** The credit limit against the balance; null without a limit or without the sales section. */
    credit: Credit | null;
  };
  statement: Statement | null;
  /** The credit warning, grace and hold (feat/credit-hold; GET /api/customers/[id]/credit's shape). */
  creditState?: CreditState | null;
  /** «مستثنى من عمولة العميل الجديد» — present only for a sales manager / admin / plan or settings manager. */
  newClientCommission?: { newClientCommissionExcluded: boolean; newClientExclusionReason: string | null; newClientExclusionAt: string | null } | null;
  files: CustomerFile[];
  /** `direct`: files over 4 MB upload from the browser straight to the private Blob store (up to 20 MB). */
  fileLimits?: { maxBytes: number; direct?: boolean };
  /** The company's contract notice period in days (batch 24 WP-C); a file's own value wins. */
  contractNoticeDays?: number;
  /** The derived tier within the account owner's book (WP-B «يومي»); null without an owner or without sales access. */
  tier?: "VIP" | "REGULAR" | "SMALL" | "QUIET" | null;
  openDeal: OpenDeal | null;
  nextStep: Activity | null;
  openDeals: number;
  stages: Stage[] | null;
  deals: Deal[] | null;
  quotes: Quote[] | null;
  samples: Sample[] | null;
  orders: Order[] | null;
  collections: Collection[] | null;
  timeline: TimelineEntry[];
  can: { edit: boolean; manageProfiles: boolean; manageFiles: boolean; logActivity: boolean; quote: boolean; createDeal: boolean; editOwner?: boolean; editCreditTerms?: boolean; editFileDates?: boolean };
  now: string;
};
