import { preparedImportSchema, multipartImportSchema, importParts } from "./parts";
import { TRANSFER_REQUEST_BYTES } from "../../domain/transfer-parts";
import { z } from "zod";
import { COOKIE_NAME, verifySession } from "../auth/session";
import { requireStepUp } from "../auth/step-up";
import { getUserById } from "../db/users";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { KeyWrapper } from "../crypto/key-wrapper";
import { parseBody, HttpError } from "../http/validate";
import { importExportDocument } from "./import";

export interface TransferImportDeps { db: Db; clock: Clock; keyWrapper: KeyWrapper; publicOrigin: string }
export function createTransferImportHandler(deps: TransferImportDeps) {
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  return async (request: Request): Promise<Response> => {
    if (request.headers.get("origin") !== deps.publicOrigin) return reply(403, { error: "forbidden" });
    const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    const session = token ? await verifySession(deps.db, token, { clock: deps.clock }) : null;
    if (!session) return reply(401, { error: "unauthenticated" });
    if (!requireStepUp(session, { clock: deps.clock })) return reply(403, { error: "step_up_required" });
    try {
      // Cached clients may still send the original single-request format. Keep
      // its existing wire allowance while bounding each new staged payload.
      const body = await parseBody(z.union([preparedImportSchema, multipartImportSchema]), request, { maxBytes: 26 * 1024 * 1024 });
      if ("operation" in body && Buffer.byteLength(JSON.stringify(body)) > TRANSFER_REQUEST_BYTES) {
        throw new HttpError(413, "Import part too large");
      }
      const user = await getUserById(deps.db, session.userId);
      if (!user) return reply(401, { error: "unauthenticated" });
      const dek = await deps.keyWrapper.unwrap(user.wrappedDek);
      try {
        if ("operation" in body) return reply(200, await importParts(deps.db, session.userId, body, dek, deps.clock));
        const summary = await importExportDocument(deps.db, session.userId, body.document, dek, deps.clock, body.protectedVault);
        return reply(200, { status: "imported", summary });
      } finally { dek.fill(0); }
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: "invalid_import" });
      return reply(500, { error: "import_failed" });
    }
  };
}
