// Settings › Agent defaults actions — the person's "what agents see" level
// (docs/adr/read-side-protection.md, amendment 24 November 2026).
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may export
// only its framework fields, so the testable core lives here (the convention's
// `createXActions(deps)` pattern) and the page's inline server action composes it.
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5):
//   • Every method takes the person's VERIFIED Session and derives the acting user id from
//     `session.userId` — never a value from the form — so a save can only ever change the
//     session person's own level.
//   • Only the three levels are accepted; anything else is refused before anything is written.
//   • The save and its activity entry share one transaction (`auditedOwnerChange`), recorded as
//     the person's own change: the field, and the level it moved from and to.
//   • It runs purely from its injected seams (db, clock, keyWrapper): no `process.env`, no secret.

import { z } from "zod";

import { auditedOwnerChange } from "@/server/activity/owner-change";
import { getReadLevel, setReadLevel as storeSetReadLevel } from "@/server/db/read-settings";
import { readLevelLabel, type ReadLevel } from "@/domain/content/read-levels";
import type { Session } from "@/server/auth/session";
import type { Clock } from "@/server/seams/clock";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Db } from "@/server/db/index";

export interface ReadLevelActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
}

export type ReadLevelResult = { ok: true; level: ReadLevel } | { ok: false; reason: "invalid_level" };

const readLevelInputSchema = z.object({ level: z.enum(["private", "standard", "open"]) });

/** The save's input, read from the panel's form (only the chosen level). */
export function readLevelInputFromForm(form: FormData): unknown {
  return { level: form.get("readLevel") };
}

export function createReadLevelActions(deps: ReadLevelActionsDeps) {
  // Save the session person's level. A change is recorded as their own; saving the level they
  // already have writes nothing new to their activity.
  async function setReadLevel(session: Session, input: unknown): Promise<ReadLevelResult> {
    const parsed = readLevelInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid_level" };
    const { level } = parsed.data;
    return auditedOwnerChange<ReadLevelResult>(deps, session.userId, async (tx, record) => {
      const before = await getReadLevel(tx, session.userId);
      const saved = await storeSetReadLevel(tx, { userId: session.userId, level, clock: deps.clock });
      // The levels aren't sensitive, and which way it moved is what the person will want to see.
      if (saved.ok && before !== level) await record("read_level_change", { fields: ["readLevel"], from: before, to: level });
      return saved;
    });
  }

  return { setReadLevel };
}

/** The `?notice=` code a save redirects with. */
export function readLevelNoticeCode(result: ReadLevelResult): string {
  return result.ok ? `read-${result.level}` : "read-invalid";
}

/** A save's outcome in plain words, or null when the code isn't one of the panel's. */
export function readLevelNotice(code: unknown): { tone: "success" | "error"; text: string } | null {
  if (code === "read-invalid") return { tone: "error", text: "Nothing was saved. Choose one of the three options for what agents see." };
  const level = typeof code === "string" && code.startsWith("read-") ? code.slice(5) : undefined;
  if (level !== "private" && level !== "standard" && level !== "open") return null;
  return { tone: "success", text: `Saved. What agents see is now ${readLevelLabel(level)}, from each agent's next request.` };
}
