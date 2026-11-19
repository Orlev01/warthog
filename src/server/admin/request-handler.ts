// Marking a request done, or waiting again, from the admin portal's Requests page
// (docs/adr/admin-portal.md, amendment of 20 November 2026): POST /requests/update on the
// admin host (served under the internal prefix). It is the portal's one write, so it guards
// itself the way sign-out does, and more:
//   • the request Origin must be exactly the admin origin (a missing or foreign one is 403);
//   • the `__Host-wh_admin` session must verify (role, app session and idle limits re-checked),
//     or the browser is sent to the admin sign-in page and nothing changes;
//   • the form carries only a request id (a uuid) and the state to move it to, and the page
//     filter to return to, each checked against a closed vocabulary.
// It then redirects back to the Requests page on the admin origin with a notice.

import { z } from "zod";

import { getAdminDeps, type AdminDeps } from "./compose";
import { adminSignInUrl } from "./guard";
import { ADMIN_COOKIE_NAME, verifyAdminSession } from "./session";
import { readCookie } from "./signout-handler";
import { setRequestHandled } from "./requests";
import { ADMIN_REQUEST, ADMIN_REQUEST_OUTCOMES } from "../metrics/names";
import { tryRecord } from "../metrics/seam";
import { REQUEST_FILTERS, type RequestFilter } from "../../domain/admin/model";

export const REQUESTS_PATH = "/requests";

export type AdminRequestUpdateHandler = (request: Request) => Promise<Response>;

const formSchema = z.object({
  id: z.uuid(),
  to: z.enum(["done", "waiting"]),
});

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function field(form: FormData | null, name: string): string | undefined {
  const value = form?.get(name);
  return typeof value === "string" ? value : undefined;
}

export function createAdminRequestUpdateHandler(deps: Pick<AdminDeps, "db" | "clock" | "adminOrigin" | "recordMetric">): AdminRequestUpdateHandler {
  const { db, clock, adminOrigin, recordMetric } = deps;
  return async function update(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== adminOrigin) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const token = readCookie(request, ADMIN_COOKIE_NAME);
    const session = token ? await verifyAdminSession(db, token, { clock }) : null;
    if (!session) return seeOther(adminSignInUrl());

    const form = await request.formData().catch(() => null);
    const back = field(form, "filter");
    const filter: RequestFilter = (REQUEST_FILTERS as readonly string[]).includes(back ?? "") ? (back as RequestFilter) : "waiting";
    const parsed = formSchema.safeParse({ id: field(form, "id"), to: field(form, "to") });
    const backTo = (notice: string) => `${REQUESTS_PATH}?filter=${filter}&notice=${notice}`;
    if (!parsed.success) return seeOther(backTo("problem"));

    const changed = await setRequestHandled(db, parsed.data.id, parsed.data.to === "done" ? clock.now() : null);
    if (!changed) return seeOther(backTo("problem"));
    await tryRecord(recordMetric, { name: ADMIN_REQUEST, value: 1, dimensions: { outcome: ADMIN_REQUEST_OUTCOMES[parsed.data.to] } });
    return seeOther(backTo(parsed.data.to));
  };
}

export function createAdminRequestUpdateRouteHandler(seams: { getDeps?: () => Promise<AdminDeps> } = {}): AdminRequestUpdateHandler {
  let handler: Promise<AdminRequestUpdateHandler> | undefined;
  return (request) => {
    handler ??= (seams.getDeps ?? getAdminDeps)().then(createAdminRequestUpdateHandler);
    handler.catch(() => { handler = undefined; });
    return handler.then((h) => h(request));
  };
}
