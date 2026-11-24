// Categories an agent suggests for one person (docs/adr/life-admin-profile.md, "When nothing
// fits"). People have different things in their lives, so the built-in catalogue can't cover
// everyone; when nothing fits, the person's agent may suggest a category of its own — in a fixed,
// generic shape Warthog can validate and render like any built-in one. The person keeps or
// declines it.
//
// A suggestion is written by an agent that has just read the person's email, so it is treated as
// untrusted: every check here is deterministic and runs in the MCP input schema, so a refused
// suggestion is recorded without its parameters. Labels are plain words (no links, no long digit
// runs, no markup); field names Warthog never keeps are refused, and so are health details; a
// built-in category under another name is refused with the kind to use instead.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { z } from "zod";

import { forbiddenFieldName } from "./identifiers";
import { fieldKey } from "./normalise";
import {
  BUILT_IN_TYPES,
  CATEGORY_ICONS,
  ACCOUNT_FIELDS,
  COMMON_LEADING,
  COMMON_TRAILING,
  BOOKING_FIELDS,
  CASE_FIELDS,
  FIELD_KINDS,
  LIFE_AREAS,
  type DueMeans,
} from "./record-types";
import type { CustomCategoryDefinition } from "./catalogue";

export const MAX_CUSTOM_CATEGORIES = 12;
export const MAX_WAITING_SUGGESTIONS = 3;
export const MAX_KINDS = 4;
export const MAX_ANCHOR_KINDS = 2;
export const MAX_OWN_FIELDS = 12;

// Random, never derived from the label: no plaintext anywhere names the category.
const SLUG_ALPHABET = "bcdfghjkmnpqrstvwxz23456789";
export const SLUG_PATTERN = /^x_[bcdfghjkmnpqrstvwxz2-9]{6}$/;

/** A category id from 6 random bytes (the server supplies them). */
export function slugFrom(bytes: Uint8Array): string {
  return `x_${Array.from(bytes.slice(0, 6), (byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join("")}`;
}

// ---- text rules ----------------------------------------------------------------------------

function tidy(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} &'’,.()/+-]{1,39}$/u;
const MARKUP = /[<>{}[\]`|#*_~\u0000-\u001f\u007f]/;
// Links, addresses and long digit runs have no place in a category's words.
const LINKISH = /https?:|www\.|@|\d{6,}/i;

const plainLabel = z.string().transform(tidy).pipe(z.string().regex(LABEL, "Use 2 to 40 plain letters, numbers and simple punctuation."));
const plainText = (max: number) => z.string().transform(tidy).pipe(z.string().min(1).max(max).refine((value) => !MARKUP.test(value), "Use plain words, without markup."));
const key = (max: number) => z.string().regex(new RegExp(`^[a-z][a-z0-9_]{1,${max - 1}}$`), "Use lower-case letters, digits and underscores.");

const DUE_MEANS: readonly DueMeans[] = ["expires", "renews", "due", "ends", "return_by", "starts"];

export const customFieldSchema = z.object({
  key: key(32),
  label: plainLabel,
  kind: z.enum(FIELD_KINDS),
  unit: z.string().max(12).optional(),
  choices: z.array(z.string().min(1).max(30)).max(8).optional(),
  hint: plainText(80).optional(),
});

export const customKindSchema = z.object({
  key: key(24),
  label: plainLabel,
  lifecycle: z.enum(["standing", "booking", "case"]),
  use: plainText(140),
  anchor: z.boolean().optional(),
  account: z.boolean().optional(),
  belongsTo: z.array(z.string().max(80)).max(6).optional(),
  due: z.object({ means: z.enum(DUE_MEANS as [DueMeans, ...DueMeans[]]), label: plainText(24) }).optional(),
  fields: z.array(customFieldSchema).max(MAX_OWN_FIELDS).default([]),
  identity: z.array(key(32)).min(1).max(3).optional(),
});

// Field names a kind may not use: Warthog's own bookkeeping.
const RESERVED_KEYS = new Set([
  "type", "kind", "category", "status", "state", "due_date", "duedate", "parent", "parent_id", "id", "meta",
  "source", "match_key", "match_keys", "journal", "steward", "handover", "decisions", "details", "review_state",
]);

// Health details are never life admin (docs/adr/life-admin-profile.md, "Never kept").
const HEALTH_DETAIL = /\b(diagnos\w*|condition|medications?|medicines?|drugs?|dosages?|doses?|results?|symptoms?|prognosis)\b/i;

// Sensitive parts of someone's life an agent mustn't turn into a category (docs/adr/profile-build.md;
// sensitive information under the Australian Privacy Principles): health and treatment, religion,
// politics, unions, sexuality, criminal matters and ethnicity. Health has its own built-in category.
const SENSITIVE = new RegExp(
  [
    "\\b(ivf|fertility|psychiatr\\w*|psycholog\\w*|counsell?ing|therapy|therapist|rehab\\w*|addiction|cancer|oncology|hiv|chemo\\w*|mental health|disabilit\\w*)\\b",
    "\\b(church|mosque|synagogue|religio\\w*|worship|tithe\\w*)\\b",
    "\\b(politic\\w*|political party)\\b",
    "\\b(trade|labou?r|workers'?|industrial|teachers'?|nurses'?)\\s+unions?\\b|\\bunion\\s+(dues|fees|membership|meetings?)\\b",
    "\\b(sexual\\w*|lgbt\\w*|gay|lesbian|queer|transgender)\\b",
    "\\b(criminal|convictions?|parole|probation|bail)\\b",
    "\\b(ethnic\\w*|racial)\\b",
  ].join("|"),
  "i",
);
const SENSITIVE_MESSAGE =
  "Warthog doesn't keep a category about health, religion, politics, a union, sexuality or criminal matters. Leave it out.";

// The built-in kind a suggested category would only duplicate, by its label.
const BUILT_IN_SYNONYMS: Readonly<Record<string, string>> = {
  flight: "travel.flight", flights: "travel.flight", airfare: "travel.flight",
  hotel: "travel.stay", hotels: "travel.stay", accommodation: "travel.stay", stays: "travel.stay", airbnb: "travel.stay",
  trip: "travel.trip", trips: "travel.trip", travel: "travel.trip", holiday: "travel.trip", holidays: "travel.trip",
  car: "vehicles.vehicle", cars: "vehicles.vehicle", vehicle: "vehicles.vehicle", vehicles: "vehicles.vehicle",
  motorcycle: "vehicles.vehicle", motorbike: "vehicles.vehicle", boat: "vehicles.vehicle", boats: "vehicles.vehicle",
  caravan: "vehicles.vehicle", rego: "vehicles.registration", registration: "vehicles.registration",
  insurance: "insurance.other", "car insurance": "vehicles.insurance", "health insurance": "health.insurance",
  "home insurance": "home.insurance", "pet insurance": "pets.insurance", "travel insurance": "insurance.travel",
  gym: "subscriptions.membership", "gym membership": "subscriptions.membership", memberships: "subscriptions.membership",
  subscription: "subscriptions.service", subscriptions: "subscriptions.service", streaming: "subscriptions.service",
  "frequent flyer": "subscriptions.loyalty", loyalty: "subscriptions.loyalty", "loyalty programs": "subscriptions.loyalty",
  bills: "utilities.energy", utilities: "utilities.energy", electricity: "utilities.energy", gas: "utilities.energy",
  internet: "utilities.internet", nbn: "utilities.internet", mobile: "utilities.phone", phone: "utilities.phone",
  super: "investing.super", superannuation: "investing.super", investments: "investing.investment", shares: "investing.investment", crypto: "investing.investment",
  bank: "banking.account", banking: "banking.account", "credit card": "banking.card", "credit cards": "banking.card", loans: "banking.loan",
  tax: "government.lodgement", taxes: "government.lodgement", fines: "government.fine", centrelink: "government.payment",
  passport: "id.passport", passports: "id.passport", licence: "id.driver_licence", license: "id.driver_licence", visa: "id.visa", visas: "id.visa",
  pet: "pets.pet", pets: "pets.pet", dog: "pets.pet", dogs: "pets.pet", cat: "pets.pet", cats: "pets.pet", vet: "pets.appointment",
  kids: "family.child", children: "family.child", school: "family.school", childcare: "family.school",
  restaurant: "outings.restaurant", restaurants: "outings.restaurant", dining: "outings.restaurant",
  events: "outings.event", tickets: "outings.event", concerts: "outings.event", haircut: "outings.beauty", haircuts: "outings.beauty",
  receipts: "belongings.receipt", warranties: "belongings.receipt", purchases: "belongings.receipt",
  doctor: "health.provider", doctors: "health.provider", dentist: "health.appointment", medical: "health.appointment", appointments: "other.appointment",
  rent: "home.lease", rental: "home.lease", lease: "home.lease", home: "home.property", house: "home.property", mortgage: "home.mortgage",
  business: "business.entity", "side business": "business.entity", domains: "business.domain", hosting: "business.domain",
  work: "work.job", job: "work.job", employment: "work.job", study: "work.study", university: "work.study",
  ndis: "care.plan", "aged care": "care.plan", will: "legal.document", "power of attorney": "legal.document",
};

/** The built-in kind a category label only duplicates, or null. */
export function builtInFor(label: string): string | null {
  const phrase = tidy(label).toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  return BUILT_IN_SYNONYMS[phrase] ?? BUILT_IN_SYNONYMS[phrase.replace(/s$/, "")] ?? null;
}

const COMMON_KINDS = new Map([...COMMON_LEADING, ...ACCOUNT_FIELDS, ...COMMON_TRAILING, ...BOOKING_FIELDS, ...CASE_FIELDS].map((field) => [field.key, field.kind]));
const BUILT_IN_ANCHORS = new Set(BUILT_IN_TYPES.filter((type) => type.anchor).map((type) => type.id));

type Draft = z.infer<typeof customKindSchema>;
interface CategoryDraftShape {
  readonly label: string;
  readonly description: string;
  readonly why: string;
  readonly kinds: readonly Draft[];
}

/**
 * A category an agent suggests mustn't be about a sensitive part of someone's life: its label,
 * description and kinds are checked (not its reason, which names where the agent saw it). Only for
 * an agent's new suggestion: a category the person already kept is restored as it was.
 */
export function checkSensitiveCategory(draft: CategoryDraftShape, ctx: z.RefinementCtx, path: readonly (string | number)[] = []): void {
  const texts: [readonly (string | number)[], string | undefined][] = [
    [["label"], draft.label],
    [["description"], draft.description],
    ...draft.kinds.flatMap((kind, k): [readonly (string | number)[], string | undefined][] => [[["kinds", k, "label"], kind.label], [["kinds", k, "use"], (kind as { use?: string }).use]]),
  ];
  for (const [where, value] of texts) {
    if (value && SENSITIVE.test(value)) ctx.addIssue({ code: "custom", path: [...path, ...where], message: SENSITIVE_MESSAGE });
  }
}

/** Every rule a suggested category must meet; issues name the place and rule, never echo text. */
export function checkCategoryDraft(draft: CategoryDraftShape, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const words = (path: (string | number)[], value: string | undefined) => {
    if (value && LINKISH.test(value)) issue(path, "Leave out links, email addresses and long numbers.");
  };

  words(["label"], draft.label);
  words(["description"], draft.description);
  words(["why"], draft.why);
  const duplicate = builtInFor(draft.label);
  if (duplicate) issue(["label"], `This is already a built-in kind: save these as type "${duplicate}" instead of suggesting a category.`);
  if (HEALTH_DETAIL.test(draft.label)) issue(["label"], "Warthog doesn't keep medical details in life admin.");

  const kindKeys = draft.kinds.map((kind) => kind.key);
  if (new Set(kindKeys).size !== kindKeys.length) issue(["kinds"], "Give each kind its own key.");
  const anchorKeys = new Set(draft.kinds.filter((kind) => kind.anchor).map((kind) => kind.key));
  if (anchorKeys.size > MAX_ANCHOR_KINDS) issue(["kinds"], `At most ${MAX_ANCHOR_KINDS} kinds of a category can be things other records belong to.`);

  draft.kinds.forEach((kind, k) => {
    const at = (...rest: (string | number)[]) => ["kinds", k, ...rest];
    words(at("label"), kind.label);
    words(at("use"), kind.use);
    if (HEALTH_DETAIL.test(kind.label)) issue(at("label"), "Warthog doesn't keep medical details in life admin.");

    const ownKeys = new Set<string>();
    kind.fields.forEach((field, i) => {
      const where = at("fields", i);
      words([...where, "label"], field.label);
      words([...where, "hint"], field.hint);
      field.choices?.forEach((choice, c) => words([...where, "choices", c], choice));
      if (ownKeys.has(field.key)) issue([...where, "key"], "Give each field its own key.");
      ownKeys.add(field.key);
      if (RESERVED_KEYS.has(field.key)) issue([...where, "key"], `"${field.key}" is used by Warthog itself; choose another key.`);
      if (forbiddenFieldName(field.key) || forbiddenFieldName(fieldKey(field.label))) issue([...where, "key"], "Warthog never keeps this kind of detail (an identity number, password, code, card, bank or payment detail).");
      if (HEALTH_DETAIL.test(field.key.replace(/_/g, " ")) || HEALTH_DETAIL.test(field.label)) issue([...where, "key"], "Warthog doesn't keep medical details in life admin.");
      const common = COMMON_KINDS.get(field.key);
      if (common && common !== field.kind) issue([...where, "kind"], `"${field.key}" is a field every record has, of kind ${common}; leave it out or keep that kind.`);
    });

    const available = new Set([...ownKeys, ...COMMON_KINDS.keys(), "parent", "title"]);
    kind.identity?.forEach((part, i) => {
      if (!available.has(part)) issue(at("identity", i), `"${part}" isn't one of this kind's fields.`);
    });

    if (kind.anchor && kind.belongsTo && kind.belongsTo.length > 0) issue(at("belongsTo"), "A thing other records belong to can't itself belong to something.");
    kind.belongsTo?.forEach((target, i) => {
      const ok = target === "any"
        || (target.startsWith("self.") && anchorKeys.has(target.slice(5)))
        || BUILT_IN_ANCHORS.has(target);
      if (!ok) issue(at("belongsTo", i), "Name \"any\", a built-in anchor kind (such as vehicles.vehicle or home.property), or \"self.<key>\" for an anchor kind of this category.");
    });
  });
}

export const newCategorySchema = z
  .object({
    label: plainLabel,
    description: plainText(140),
    lifeArea: z.enum(LIFE_AREAS),
    icon: z.enum(CATEGORY_ICONS).optional(),
    why: plainText(200),
    kinds: z.array(customKindSchema).min(1).max(MAX_KINDS),
  })
  .superRefine(checkCategoryDraft);
export type NewCategory = z.infer<typeof newCategorySchema>;

/** The stored definition of a validated suggestion. */
export function definitionOf(draft: NewCategory): CustomCategoryDefinition & { readonly why: string } {
  return {
    label: draft.label,
    description: draft.description,
    lifeArea: draft.lifeArea,
    icon: draft.icon ?? "shapes",
    why: draft.why,
    kinds: draft.kinds.map((kind) => ({
      key: kind.key,
      label: kind.label,
      lifecycle: kind.lifecycle,
      use: kind.use,
      ...(kind.anchor ? { anchor: true } : {}),
      ...(kind.account && kind.lifecycle === "standing" && !kind.anchor ? { account: true } : {}),
      ...(kind.belongsTo && kind.belongsTo.length > 0 ? { belongsTo: kind.belongsTo } : {}),
      ...(kind.due ? { due: kind.due } : {}),
      fields: kind.fields.map((field) => ({ key: field.key, label: field.label, kind: field.kind, ...(field.unit ? { unit: field.unit } : {}), ...(field.choices ? { choices: field.choices } : {}), ...(field.hint ? { hint: field.hint } : {}) })),
      ...(kind.identity ? { identity: kind.identity } : {}),
    })),
  };
}

/** Labels that mean the same thing (for "the person declined one like this" and reuse). */
export function sameLabel(a: string, b: string): boolean {
  const norm = (value: string) => new Set(tidy(value).toLowerCase().replace(/&/g, "and").split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((word) => word.replace(/s$/, "")));
  const left = norm(a);
  const right = norm(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && shared / union >= 0.5;
}
