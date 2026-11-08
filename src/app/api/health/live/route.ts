// The App-Router entry for `/api/health/live` — the liveness probe: the process answers. It
// touches neither config nor the database, so a database outage never restarts a healthy
// container (readiness, `/api/health`, takes the revision out of traffic instead).

import { liveResponse } from "../handler";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return liveResponse();
}
