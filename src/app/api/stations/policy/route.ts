import { NextResponse } from "@/lib/api-response";
import { requireAuth, requireAdminAction } from "@/lib/auth-server";
import { body, noStore, usersErrorResponse } from "@/lib/users/http";
import { setPolicy } from "@/lib/services/station/admin";

// PUT {idleMinutes?, pinMaxAttempts?, activationMinutes?, reason?} — the station policy (owner decision
// D7; defaults idle 5 min, 5 PIN attempts, activation code 15 min; null returns a value to its
// default). The administrator role, step-up.
export async function PUT(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const refused = await requireAdminAction(user, "stations.policy", { stepUp: true });
  if (refused) return refused;
  try {
    return NextResponse.json({ policy: await setPolicy(request, user, await body(request)) }, noStore);
  } catch (e) {
    return usersErrorResponse(e);
  }
}
