// "Contact us" (docs/adr/requests-for-members.md): what a message can be about, as the person
// picks it and the operator reads it, and the limits on a message. Pure, so views and the
// server share one source.

export const CONTACT_TOPICS = ["question", "problem", "privacy", "idea", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export const CONTACT_TOPIC_LABELS: Readonly<Record<ContactTopic, string>> = {
  question: "A question",
  problem: "Something isn't working",
  privacy: "A privacy request",
  idea: "An idea",
  other: "Something else",
};

// The longest message a person can send, in characters (after cleaning).
export const CONTACT_MESSAGE_MAX = 2000;
// How many messages one person can send in a day before the next is turned away.
export const CONTACT_DAILY_LIMIT = 5;

export function isContactTopic(value: unknown): value is ContactTopic {
  return typeof value === "string" && (CONTACT_TOPICS as readonly string[]).includes(value);
}
