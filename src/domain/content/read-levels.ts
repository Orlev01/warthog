// Read-side protection — how much Warthog hides from what agents read, chosen by the person
// (docs/adr/read-side-protection.md, amendment 24 November 2026).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// The founder's decision: people set this themselves, from a short set of options rather than
// rules they write. Three levels cover almost everyone:
//   • private  — everything Standard hides, plus the numbers that identify the person or their
//                accounts when the text names them (tax file, Medicare, passport, licence, BSB,
//                account, member, policy, customer and card numbers);
//   • standard — sign-in codes, sign-in and password-reset links and card numbers (the default);
//   • open     — nothing hidden: emails and files as written, sign-in emails included.
// At every level invisible characters are removed (they hide nothing a person can see) and the
// content is marked as written by others. The "recently read" ask-first check never changes.

export type ReadLevel = "private" | "standard" | "open";

/** The level of a person who has chosen nothing. */
export const DEFAULT_READ_LEVEL: ReadLevel = "standard";

export interface ReadLevelChoice {
  readonly value: ReadLevel;
  readonly label: string;
  /** One plain line saying what the level does. */
  readonly description: string;
  readonly recommended?: true;
}

/** The levels as the person chooses them, most private first. */
export const READ_LEVELS: readonly ReadLevelChoice[] = [
  {
    value: "private",
    label: "Private",
    description: "Also hides tax file, Medicare, passport, licence, BSB and account numbers. Agents can't fill account numbers in for you.",
  },
  {
    value: "standard",
    label: "Standard",
    description: "Hides sign-in codes, password-reset links and card numbers.",
    recommended: true,
  },
  {
    value: "open",
    label: "Everything",
    description: "Shows emails and files as written, including sign-in codes and password-reset links.",
  },
];

/** What the person is told when they choose to show everything. */
export const OPEN_LEVEL_WARNING =
  "With Everything, an agent, or an email written to trick one, could use a sign-in code or password-reset link to get into one of your accounts.";

/** Whether `value` is one of the three levels. */
export function isReadLevel(value: unknown): value is ReadLevel {
  return value === "private" || value === "standard" || value === "open";
}

/** A level's plain label ("Everything" for open). */
export function readLevelLabel(level: ReadLevel): string {
  return READ_LEVELS.find((choice) => choice.value === level)?.label ?? level;
}
