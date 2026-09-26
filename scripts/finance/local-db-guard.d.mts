export const MARKER: string;
export const DISPOSABLE_DATABASES: string[];
export const SHARED_ENDPOINTS: string[];
export function checkUrl(rawUrl: string | undefined, expectedDb: string, env?: Record<string, string | undefined>): string[];
export function assertDisposableFinanceDb(args: { url: string | undefined; expectedDb: string; query: (sql: string) => Promise<unknown>; env?: Record<string, string | undefined> }): Promise<void>;
