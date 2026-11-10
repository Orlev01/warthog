import { z } from "zod";
import type { Db } from "../db/index";
import type { BlobStore } from "./blob";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import { verifySession } from "../auth/session";
import { getUserById } from "../db/users";
import { getReceiptFile } from "./receipt-files";

export function createReceiptDownloadHandler(deps: { db: Db; blob: BlobStore; keyWrapper: KeyWrapper; clock: Clock }) {
  return async (request: Request, id: string): Promise<Response> => {
    const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
    const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("__Host-wh_session="))?.slice("__Host-wh_session=".length);
    const session = token ? await verifySession(deps.db, token, { clock: deps.clock }) : null;
    if (!session) return new Response(null, { status: 401, headers });
    if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404, headers });
    const owned = await deps.db.query("SELECT id FROM receipt_files WHERE id=$1 AND user_id=$2", [id, session.userId]);
    if (owned.rows.length === 0) return new Response(null, { status: 404, headers });
    const user = await getUserById(deps.db, session.userId);
    if (!user) return new Response(null, { status: 404, headers });
    const dek = await deps.keyWrapper.unwrap(user.wrappedDek);
    const file = await getReceiptFile(deps.db, deps.blob, { userId: session.userId, id }, dek);
    if (!file) return new Response(null, { status: 404, headers });
    // Untrusted file contents are always downloaded, never rendered as app-origin HTML.
    const extensions: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "text/plain": "txt" };
    const extension = extensions[file.contentType] ?? "bin";
    return new Response(new Uint8Array(file.bytes), { headers: {
      ...headers, "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="receipt-${id}.${extension}"`,
      "content-length": String(file.bytes.byteLength),
    } });
  };
}
