import { exportDocumentSchema, type ExportDocument } from "../server/export/schema";
import type { SealedVault } from "./data-transfer";

export const TRANSFER_PART_BYTES = 4 * 1024 * 1024;
export const TRANSFER_REQUEST_BYTES = 12 * 1024 * 1024;
export const TRANSFER_MAX_PARTS = 100_000;
const arrays = ["skills", "skillPackages", "memory", "rules", "tasks", "lifeAdmin", "connections", "activity", "importedActivity"] as const;
export function emptyTransferDocument(exportedAt: string): ExportDocument {
  return { version: 1, exportedAt, profile: {}, preferences: {}, skills: [], skillPackages: [], memory: [], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [], importedActivity: [] };
}

/** Independent, schema-valid parts; package-derived skills are restored by their package. */
export function* splitTransferDocument(document: ExportDocument): Generator<ExportDocument> {
  const doc = exportDocumentSchema.parse(document);
  const packageIds = new Set(doc.skillPackages?.map(p => p.id).filter(Boolean));
  let part: ExportDocument = { ...emptyTransferDocument(doc.exportedAt), profile: doc.profile, preferences: doc.preferences };
  let size = new TextEncoder().encode(JSON.stringify(part)).length;
  if (size > TRANSFER_REQUEST_BYTES - 4096) throw new Error("The exported profile exceeds the transfer part limit");
  for (const key of arrays) {
    for (const item of doc[key] ?? []) {
      if (key === "skills" && "packageId" in item && typeof item.packageId === "string" && packageIds.has(item.packageId)) continue;
      const itemSize = new TextEncoder().encode(JSON.stringify(item)).length + 1;
      if (itemSize > TRANSFER_REQUEST_BYTES - 4096) throw new Error("A single exported item exceeds the transfer part limit");
      if (size + itemSize > TRANSFER_PART_BYTES) {
        yield part;
        part = emptyTransferDocument(doc.exportedAt); size = 512;
      }
      (part[key] as unknown[]).push(item); size += itemSize;
    }
  }
  yield part;
}

/** Protected fields are already encrypted on the device. Do not put their whole
 * collection on the first request: it can be larger than an ordinary document. */
export function* splitPreparedTransfer(document: ExportDocument, protectedVault?: SealedVault): Generator<{ document: ExportDocument; protectedVault?: SealedVault }> {
  for (const part of splitTransferDocument(document)) yield { document: part };
  if (!protectedVault) return;
  let vault: SealedVault = { highTierFields: [], cards: [] }, size = 512;
  for (const key of ["highTierFields", "cards"] as const) {
    for (const item of protectedVault[key]) {
      const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
      if (bytes > TRANSFER_REQUEST_BYTES - 4096) throw new Error("A protected item exceeds the transfer part limit");
      if (size + bytes > TRANSFER_PART_BYTES) {
        yield { document: emptyTransferDocument(document.exportedAt), protectedVault: vault };
        vault = { highTierFields: [], cards: [] }; size = 512;
      }
      (vault[key] as unknown[]).push(item); size += bytes;
    }
  }
  if (vault.highTierFields.length || vault.cards.length) yield { document: emptyTransferDocument(document.exportedAt), protectedVault: vault };
}
