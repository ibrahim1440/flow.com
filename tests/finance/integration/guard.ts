// Evaluated before the database client is imported: refuse anything but the local
// disposable test DB (URL, port, name, FIN_DISPOSABLE_DB). The server-side marker is checked in
// support.ts before the first TRUNCATE.
import { checkUrl } from "../../../scripts/finance/local-db-guard.mjs";

const problems = checkUrl(process.env.DATABASE_URL, "erp_finance_integration");
if (problems.length) throw new Error(`Refusing to run finance integration tests: ${problems.join("; ")}.`);
export {};
