import { hrHandler } from "@/lib/hr/http";
import { listDirectory } from "@/lib/hr/services/people";

export const GET = hrHandler(async ({ actor, query, today }) => listDirectory(actor, { q: query.get("q"), status: query.get("status"), view: query.get("view"), branchId: query.get("branchId"), departmentId: query.get("departmentId"), page: Number(query.get("page") ?? 1), pageSize: Number(query.get("pageSize") ?? 25) }, today));
