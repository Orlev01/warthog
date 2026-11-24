// A default skill Warthog gives every person, which they can edit, switch off, remove and
// restore (docs/adr/editable-builtin-skills.md). Its text is guidance only: Warthog's ground
// rules (the house skill's fixed part) and its server-side checks carry the safety, so editing
// or removing a default can never weaken it.
import type { SkillGate } from "../gates";

export interface DefaultSkillText {
  // Stable key, snake_case, never shown. Keeps an edit attached when the title changes.
  readonly key: string;
  // 2 to 5 plain words.
  readonly title: string;
  // The only thing an agent sees before deciding to fetch it: what it's for and the words
  // people and emails use. At most 200 characters, starting "when ".
  readonly useThisWhen: string;
  // Listed only for an agent that passes every gate.
  readonly requires: readonly SkillGate[];
  // Bumped whenever the text changes, so a person's edit of an older text can be offered the new one.
  readonly version: number;
  // The body: 150 to 450 words, lines joined with "\n".
  readonly guidance: string;
}

// Where a default sits on the Skills page, and whether it starts switched on.
export type DefaultSkillGroup = "everyday" | "pack";
