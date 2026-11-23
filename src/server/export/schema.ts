// E16-S01 — Export/import document schema.
//
// Export and import must agree on ONE documented, versioned shape so a file
// produced by export is accepted by import (brief "Export and portability" /
// "Import"; design: data portability). This module is that single contract: both
// the export producer and the import reader parse against the SAME schema, which
// is why it lives on its own and keeps the two sides from drifting.
//
// It is an ENVELOPE schema. It pins the top-level shape — a versioned wrapper with
// the ten required sections plus the optional device-protected block — and checks
// that each section is the right KIND (an object where an object is due, an array
// where a list is due). Each section's representative fields are declared so the
// contract documents them, and every section is a LOOSE object so an export never
// loses a field this envelope did not name (import re-protects/rehydrates the
// whole section). Validating a document is a pure, in-memory operation.
//
// The deviceProtected section legitimately carries the person's DECRYPTED
// high-tier values and card numbers — the brief exports them "decrypted on the
// device" and import "re-protects them on the importing device". Parsing never
// writes them to activity, logs or metrics (the CLAUDE.md redaction rule governs
// that, in the producer, not here); this module only defines their shape.

import { z } from "zod";

// --- Object sections ------------------------------------------------------

// Who the person is — their low-tier identity. Loose so any identity field an
// export carries survives the round-trip.
const profileSchema = z.looseObject({
  name: z.string().optional(),
  email: z.string().optional(),
});

// How the person likes agents to work — tone / length / language / units / etc.
const preferencesSchema = z.looseObject({
  tone: z.string().optional(),
  language: z.string().optional(),
});

// --- Array-section elements ----------------------------------------------

const skillSchema = z.looseObject({
  scope: z.enum(["all", "chosen"]).optional(),
  enabled: z.boolean().optional(),
  scopedAgentIds: z.array(z.string()).optional(),
  id: z.string().optional(),
  title: z.string().optional(),
});

const memorySchema = z.looseObject({
  id: z.string().optional(),
  content: z.string().optional(),
});

const ruleSchema = z.looseObject({
  id: z.string().optional(),
  kind: z.string().optional(),
});

const taskSchema = z.looseObject({
  id: z.string().optional(),
  title: z.string().optional(),
});

const lifeAdminSchema = z.looseObject({
  id: z.string().optional(),
  kind: z.string().optional(),
});

// A connection as exported carries no secret — only the catalogue id and a label.
const connectionSchema = z.looseObject({
  id: z.string().optional(),
  connectorId: z.string().optional(),
  accountLabel: z.string().optional(),
});

const activitySchema = z.looseObject({
  seq: z.number().optional(),
  kind: z.string().optional(),
});

// --- The optional device-protected section --------------------------------

// A decrypted high-tier identity value (e.g. a passport number). Present only
// after a step-up device decrypt, so import can re-protect it on the new device.
const highTierFieldSchema = z.looseObject({
  type: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
});

// A card as exported — its decrypted number alongside the brand/last-four an
// importing device re-encrypts. (Security codes are never stored or exported.)
const cardSchema = z.looseObject({
  brand: z.string().optional(),
  lastFour: z.string().optional(),
  nickname: z.string().optional(),
  number: z.string().optional(),
});

// The high-tier values and cards a step-up device export carries. Omitted
// entirely by a server-only export (hence the whole section is optional above).
const deviceProtectedSchema = z.looseObject({
  highTierFields: z.array(highTierFieldSchema),
  cards: z.array(cardSchema),
});

// --- The export document envelope ------------------------------------------

// The zod schema for one Warthog export document. Exported so the export producer
// and the import reader validate against the same shape.
export const exportDocumentSchema = z.looseObject({
  // The export-format version — the number 1 for this contract. A document
  // missing it is rejected (an unversioned file cannot be read safely).
  version: z.literal(1),
  // When the export was produced (ISO 8601 string).
  exportedAt: z.string(),
  agentSettings: z.record(z.string(), z.unknown()).optional(),
  profile: profileSchema,
  preferences: preferencesSchema,
  skills: z.array(skillSchema),
  skillPackages: z.array(z.object({
    id: z.uuid().optional(),
    name: z.string().max(150),
    files: z.array(z.object({ path: z.string().max(300), content: z.string().max(200_000) })).min(1).max(100),
  })).max(1000).optional(),
  memory: z.array(memorySchema),
  rules: z.array(ruleSchema),
  tasks: z.array(taskSchema),
  lifeAdmin: z.array(lifeAdminSchema),
  // The person's own categories, settings for built-ins and declined suggestions
  // (docs/adr/life-admin-profile.md); optional, so older exports still import.
  lifeAdminCategories: z.array(z.looseObject({ slug: z.string().max(40).optional(), state: z.string().max(20).optional() })).max(500).optional(),
  connections: z.array(connectionSchema),
  activity: z.array(activitySchema),
  importedActivity: z.array(activitySchema).optional(),
  // Present only after a step-up device decrypt; a server-only export omits it.
  deviceProtected: deviceProtectedSchema.optional(),
});

export type ExportDocument = z.infer<typeof exportDocumentSchema>;
