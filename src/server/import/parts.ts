import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { sealedVaultSchema } from "../../domain/data-transfer";
import { TRANSFER_MAX_PARTS } from "../../domain/transfer-parts";
import { exportDocumentSchema } from "../export/schema";
import { withTransaction, type Db } from "../db/index";
import { encrypt, decrypt } from "../crypto/envelope";
import { HttpError } from "../http/validate";
import type { Clock } from "../seams/clock";
import { importExportDocument } from "./import";
import { createRedactingRecorder } from "../mcp/recorder";

export const preparedImportSchema = z.strictObject({
  document: exportDocumentSchema.refine(doc => !Object.hasOwn(doc, "deviceProtected")),
  protectedVault: sealedVaultSchema.optional(),
});
export const multipartImportSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("begin"), partCount: z.number().int().min(1).max(TRANSFER_MAX_PARTS) }),
  z.strictObject({ operation: z.literal("part"), id: z.uuid(), seq: z.number().int().min(0).max(TRANSFER_MAX_PARTS - 1), part: preparedImportSchema }),
  z.strictObject({ operation: z.literal("commit"), id: z.uuid() }),
  z.strictObject({ operation: z.literal("cancel"), id: z.uuid() }),
]);
export async function importParts(db: Db, userId: string, input: z.infer<typeof multipartImportSchema>, dek: Uint8Array, clock: Clock) {
  return withTransaction(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`data-import:${userId}`]);
    const expiresBefore = new Date(clock.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    await tx.query("DELETE FROM data_imports WHERE user_id = $1 AND created_at < $2", [userId, expiresBefore]);
    if (input.operation === "begin") {
      await tx.query("DELETE FROM data_imports WHERE user_id = $1 AND status = 'pending'", [userId]);
      const id = randomUUID();
      await tx.query("INSERT INTO data_imports (id, user_id, part_count, created_at) VALUES ($1,$2,$3,$4)", [id, userId, input.partCount, clock.now().toISOString()]);
      return { status: "ready", id };
    }
    const row = (await tx.query("SELECT part_count, status FROM data_imports WHERE user_id = $1 AND id = $2 FOR UPDATE", [userId, input.id])).rows[0];
    if (!row) throw new HttpError(404, "Import unavailable or expired");
    if (input.operation === "cancel") {
      if (row.status !== "complete") await tx.query("DELETE FROM data_imports WHERE user_id = $1 AND id = $2", [userId, input.id]);
      return { status: row.status === "complete" ? "imported" : "cancelled" };
    }
    if (row.status === "complete") return { status: "imported" };
    if (input.operation === "part") {
      if (input.seq >= Number(row.part_count)) throw new HttpError(400, "Invalid part index");
      const content = JSON.stringify(input.part), digest = createHash("sha256").update(content).digest("hex");
      const existing = (await tx.query("SELECT digest FROM data_import_parts WHERE user_id = $1 AND import_id = $2 AND seq = $3", [userId, input.id, input.seq])).rows[0];
      if (existing) {
        if (existing.digest !== digest) throw new HttpError(409, "Import part conflicts");
      } else {
        const ct = await encrypt(dek, "data_import_parts", "content_ct", `${userId}:${input.id}:${input.seq}`, content);
        await tx.query("INSERT INTO data_import_parts (user_id, import_id, seq, content_ct, digest) VALUES ($1,$2,$3,$4,$5)", [userId, input.id, input.seq, ct, digest]);
      }
      return { status: "staged" };
    }
    const count = Number((await tx.query("SELECT count(*) AS n FROM data_import_parts WHERE user_id = $1 AND import_id = $2", [userId, input.id])).rows[0]!.n);
    if (count !== Number(row.part_count)) throw new HttpError(409, "Import has missing parts");
    const transferContext = { importedAddresses: new Map<string, string>() };
    for (let seq = 0; seq < count; seq++) {
      const part = (await tx.query("SELECT content_ct FROM data_import_parts WHERE user_id = $1 AND import_id = $2 AND seq = $3", [userId, input.id, seq])).rows[0]!;
      const content = await decrypt(dek, "data_import_parts", "content_ct", `${userId}:${input.id}:${seq}`, String(part.content_ct));
      const parsed = preparedImportSchema.parse(JSON.parse(content));
      await importExportDocument(tx, userId, parsed.document, dek, clock, parsed.protectedVault, transferContext);
    }
    await createRedactingRecorder({db:tx, clock, dekFor:async()=>dek}).record({ userId, kind: "account_imported", source: "warthog", outcome: "saved", payload: { summary: "Account data imported", parts: count } });
    await tx.query("UPDATE data_imports SET status = 'complete' WHERE user_id = $1 AND id = $2", [userId, input.id]);
    await tx.query("DELETE FROM data_import_parts WHERE user_id = $1 AND import_id = $2", [userId, input.id]);
    return { status: "imported" };
  });
}
