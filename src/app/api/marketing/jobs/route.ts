import { route } from "@/lib/marketing/server/http";
import { JOBS, recentRuns, runMarketingJobs } from "@/lib/marketing/server/jobs";
import { cronSecretConfigured } from "@/lib/cron/auth";

export const maxDuration = 60;

export const GET = route(undefined, async () => ({ jobs: JOBS, runs: await recentRuns(), schedulerConfigured: cronSecretConfigured() }));

/** «تشغيل الآن» — the same run the scheduler makes. */
export const POST = route("automation_manage", async () => ({ results: await runMarketingJobs("manual") }));
