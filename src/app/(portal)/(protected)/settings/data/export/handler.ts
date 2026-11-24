// Review fix G2 — the Data & privacy export DOWNLOAD (the testable seam of the thin
// sibling `route.ts`, POST /settings/data/export).
//
// The Export control used to build the whole archive inside a server action and then
// discard it, telling the person "Your data export has been prepared" while no file ever
// reached them (brief flow 11: "export and see the download"). This handler returns the
// export document itself as a JSON attachment, through the SAME tested
// `createDataActions(...).exportData` the page used (one source of truth for the fresh
// step-up gate and the member-scoped build).
//
// Security (each a reviewer veto):
//   • The request Origin must equal the configured public origin — a cross-site or
//     Origin-less POST is 403 and builds nothing (the form posts same-origin; a
//     SameSite=Lax cookie alone does not stop a top-level cross-site form POST).
//   • Identity comes ONLY from the `__Host-wh_session` cookie; no session → /signin.
//   • A missing or stale step-up builds nothing and sends the person back to the Data &
//     privacy screen with `?notice=step_up_required`, where "Confirm it's you" is offered.
//   • The attachment is `Cache-Control: no-store` — the whole account must never linger
//     in a browser or intermediary cache.
//   • Every seam is injected (db, clock, keyWrapper, publicOrigin): this module reads no
//     `process.env` (INV-103).

import { COOKIE_NAME, verifySession } from "@/server/auth/session";
import type { DeletionExecutor } from "@/server/account/delete";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Senders } from "@/server/notify/senders";
import type { Clock } from "@/server/seams/clock";
import type { Db } from "@/server/db/index";
import { exportProtectedVault } from "@/server/export/protected";
import { listIdentityFields } from "@/server/db/identity-fields";
import { listCardBillingAddresses } from "@/server/db/card-billing-addresses";
import { getUserById } from "@/server/db/users";
import { createDataActions } from "../actions";

export interface ExportHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
  readonly publicOrigin: string;
}

const SCREEN = "/settings/data";

// The export never revokes, deletes or sends anything, so the delete-only seams of the
// data actions are wired to refuse loudly if they were ever reached.
const unusedRevoker: DeletionExecutor = {
  async revokeAgentsAndConnections(): Promise<void> {
    throw new Error("the export handler never deletes an account");
  },
};
const refuse = async (): Promise<void> => {
  throw new Error("the export handler never sends a message");
};
const unusedSenders: Senders = {
  push: { sendPush: refuse },
  email: { sendEmail: refuse },
  sms: { sendSms: refuse },
};

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

// One cookie's value out of the Cookie header (null when absent).
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createExportHandler(deps: ExportHandlerDeps): (request: Request) => Promise<Response> {
  const { db, clock, keyWrapper, publicOrigin } = deps;
  const actions = createDataActions({
    db,
    clock,
    keyWrapper,
    revoker: unusedRevoker,
    senders: unusedSenders,
  });

  return async function handle(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== publicOrigin) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const forDevice = new URL(request.url).searchParams.get("device") === "1";
    const failure = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
    const token = readCookie(request, COOKIE_NAME);
    const session = token ? await verifySession(db, token, { clock }) : null;
    if (!session) return forDevice ? failure(401, "unauthenticated") : seeOther("/signin");

    const outcome = await actions.exportData(session);
    if (!outcome.ok) return forDevice ? failure(403, outcome.reason) : seeOther(`${SCREEN}?notice=${encodeURIComponent(outcome.reason)}`);

    if (forDevice) {
      const user = await getUserById(db, session.userId);
      if (!user) return failure(401, "unauthenticated");
      const dek = await keyWrapper.unwrap(user.wrappedDek);
      // The device export carries each field's id, and each card-only billing address with its
      // id (docs/adr/card-billing-addresses.md), so the cards' billing references can be re-linked
      // when the file is imported.
      let fields, billing;
      try {
        fields = await listIdentityFields(db, session.userId, dek);
        billing = await listCardBillingAddresses(db, session.userId, dek);
      } finally { dek.fill(0); }
      const { cardBillingAddresses: _valuesOnly, ...profile } = outcome.document.profile;
      const document = { ...outcome.document, profile: {
        ...profile,
        fields: fields.map(({ id, kind, value, movingOn }) => ({ id, kind, value, movingOn })),
        ...(billing.length ? { cardBillingAddresses: billing.map(({ id, value }) => ({ id, value })) } : {}),
      } };
      return Response.json({ document, protectedVault: await exportProtectedVault(db, session.userId) }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }

    const day = clock.now().toISOString().slice(0, 10);
    return new Response(JSON.stringify(outcome.document, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="warthog-export-${day}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
