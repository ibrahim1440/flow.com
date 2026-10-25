import { route } from "@/lib/marketing/server/http";
import { publishingQueue, runPublisher } from "@/lib/marketing/server/publishing";

export const GET = route(undefined, async () => publishingQueue());

/** «تشغيل قائمة النشر الآن». */
export const POST = route("publish", async () => runPublisher());
