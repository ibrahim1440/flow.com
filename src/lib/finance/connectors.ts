// Extension point for direct bank connectivity. NOT wired to any UI.
//
// Version 1 imports statements as CSV (lib/finance/csv.ts). A future connector (an open-
// banking aggregator, a bank's corporate API, a POS/gateway settlement report) implements
// this interface and feeds rows through the SAME import path — fingerprinting, duplicate
// flagging, review queue — so nothing downstream changes.
//
// Rules for any implementation:
//   - never store online-banking usernames, passwords or OTPs; use the provider's
//     delegated, revocable token held in a secrets manager, not in this database;
//   - return the provider's own transaction id as `reference` so fingerprints are stable;
//   - return settlements with gross and fee where the provider reports them.

export type ConnectorTransaction = {
  txnDate: string; // YYYY-MM-DD, Asia/Riyadh
  amount: number; // signed halalas, net cash movement
  grossAmount?: number;
  feeAmount?: number;
  reference: string;
  description?: string;
  counterparty?: string;
  pending: boolean;
};

export interface BankFeedConnector {
  readonly id: string;
  readonly displayName: string;
  fetchTransactions(accountExternalRef: string, sinceDate: string): Promise<ConnectorTransaction[]>;
  fetchBalance?(accountExternalRef: string, asOf: string): Promise<{ balance: number; asOf: string }>;
}

/** No connector is registered in this release. Kept explicit so the UI shows none. */
export const REGISTERED_CONNECTORS: BankFeedConnector[] = [];
