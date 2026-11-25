// The built-in life-admin catalogue (docs/adr/life-admin-profile.md): the categories of a
// person's life admin, grouped into life areas, the kinds of record in each, and their fields.
//
// Records are filed by what they are ABOUT (the motorcycle, the home, health), not by what kind
// of paperwork they are. Every kind is one of three lifecycles: STANDING (an account, policy or
// document that renews or expires), BOOKING (something booked for a time, finished once it is
// over) or CASE (a matter in progress until it is resolved: a fine, a claim, an application).
// Any kind may be an ANCHOR — a thing other records belong to (a vehicle, a home, a trip, a pet,
// or a kind a person's own category declares) — and says which anchors it may belong to.
//
// This file is the built-in half of a person's catalogue. Categories an agent suggests for one
// person are data (`./custom-category.ts`), and `./catalogue.ts` merges both into the one
// `Catalogue` every reader goes through, so nothing here is looked up statically by id.
//
// Warthog never calls an AI model, so the structure an agent fills in has to come from here: the
// same definitions validate what agents save, label what the person sees, write the "Life admin
// records" skill and decide which fields identify one record so a second scan updates it.
// Government identifiers are never fields of any kind (`./identifiers.ts` refuses them).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

export const LIFE_AREAS = ["home", "getting_around", "health", "money", "papers", "work", "family", "everyday"] as const;
export type LifeArea = (typeof LIFE_AREAS)[number];

export const LIFE_AREA_LABELS: Readonly<Record<LifeArea, string>> = {
  home: "Home",
  getting_around: "Getting around",
  health: "Health and care",
  money: "Money",
  papers: "Papers and protection",
  work: "Work and business",
  family: "Family and pets",
  everyday: "Everyday",
};

// The icons a category may use (lucide names). Custom categories choose from the same set, so
// the page never renders an icon it doesn't know.
export const CATEGORY_ICONS = [
  "home", "plug", "car", "plane", "heart-pulse", "hand-heart", "landmark", "trending-up", "building",
  "shield", "id-card", "scroll", "briefcase", "store", "users", "paw-print", "shopping-bag", "repeat",
  "utensils", "shapes", "star", "ticket", "dumbbell", "music", "anchor", "sailboat", "trophy",
  "book-open", "camera", "leaf", "wrench", "gift",
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

export type Lifecycle = "standing" | "booking" | "case";

// The stored plaintext kind (db/migrations/0033 + 0117). The three original kinds keep meaning
// what they did; every other type is stored as `item`, so the plaintext column never says which
// category a record is in — the type lives encrypted.
export type StoredKind = "subscription" | "receipt_warranty" | "renewal_appointment" | "item";

// What a record's due date means, so an agent can say "expires" or "renews".
export type DueMeans = "expires" | "renews" | "due" | "ends" | "return_by" | "starts";

export const FIELD_KINDS = [
  "text", "long_text", "date", "datetime", "month_year", "amount", "currency", "cycle", "number",
  "boolean", "duration", "reference", "last4", "phone", "email", "website", "place", "person",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly choices?: readonly string[];
  readonly hint?: string;
  readonly unit?: string;
  // A field every kind has (name, provider, amount …): the skill lists these once.
  readonly common?: true;
}

export interface CategoryDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly lifeArea: LifeArea;
  readonly icon: CategoryIcon;
  // Words for "look through my email for my …".
  readonly promptWords: string;
  // Which empty categories to suggest first (lower first).
  readonly priority: number;
  readonly origin: "builtin" | "custom";
}

export interface RecordTypeDef {
  // `category.kind`, e.g. "vehicles.registration", or "x_7kq2mz.mooring" for a custom kind.
  readonly id: string;
  readonly category: string;
  readonly label: string;
  // One line for agents: what this kind is for.
  readonly use: string;
  readonly lifecycle: Lifecycle;
  // Other records can belong to a record of this kind.
  readonly anchor?: true;
  // The anchor kinds a record of this kind may belong to; "any" allows every anchor.
  readonly belongsTo?: readonly string[];
  readonly due?: { readonly means: DueMeans; readonly label: string };
  // Every field, merged: the kind's own, then its lifecycle's, then the common ones.
  readonly fields: readonly FieldDef[];
  // Alternatives, each a list of field keys whose values identify one record of this kind, so
  // saving the same thing again updates it. "parent" stands for the record it belongs to, "title"
  // for its name (or provider). Empty ⇒ never matched.
  readonly identity: readonly (readonly string[])[];
  // Used only when a record can fill none of `identity`: a bank account saved without its last 4
  // still matches its bank and name, so a later scan updates it instead of adding a copy.
  readonly fallbackIdentity?: readonly string[];
  readonly singleton?: true;
  readonly storedKind: StoredKind;
  readonly reminders?: readonly number[];
  // An account, policy or membership the person holds: it also has the name it's in and the
  // email address it's registered to (`ACCOUNT_FIELDS`), next to its number.
  readonly account?: true;
  // An identity document: any document-number-shaped value is refused.
  readonly documentLike?: true;
  // A booking with no end lasts this long.
  readonly defaultMinutes?: number;
  readonly origin: "builtin" | "custom";
}

// The cycles a cost can recur on, and how each converts to a month (for monthly totals).
export const CYCLES = ["weekly", "fortnightly", "monthly", "quarterly", "yearly", "one_off"] as const;
export type Cycle = (typeof CYCLES)[number];
export const MONTHS_PER_CYCLE: Readonly<Record<Exclude<Cycle, "one_off">, number>> = {
  weekly: 12 / 52,
  fortnightly: 12 / 26,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

export const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;

// ---- fields every kind shares, and each lifecycle's ----------------------------------------

const f = (key: string, label: string, kind: FieldKind = "text", extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind, ...extra });

// Leading common fields (identity-ish), then trailing ones (money, who, how to contact).
export const COMMON_LEADING: readonly FieldDef[] = [
  f("name", "Name", "text", { common: true }),
  f("provider", "Provider", "text", { common: true }),
  f("reference", "Reference", "reference", { common: true }),
];
export const COMMON_TRAILING: readonly FieldDef[] = [
  f("amount", "Cost", "amount", { common: true }),
  f("currency", "Currency", "currency", { common: true }),
  f("cycle", "How often", "cycle", { common: true }),
  f("for_whom", "For", "person", { common: true, hint: "Leave empty when it's yours. A first name or relationship only." }),
  f("contact", "Phone or how to contact", "phone", { common: true }),
  f("email", "Email", "email", { common: true }),
  f("website", "Website", "website", { common: true }),
  f("notes", "Notes", "long_text", { common: true }),
];
export const COMMON_FIELD_KEYS: readonly string[] = [...COMMON_LEADING, ...COMMON_TRAILING].map((field) => field.key);

// What identifies an account, policy or membership to the person, beside its number (`reference`,
// named by the kind: "Member number", "Policy number"): the name it's in and the email address
// it's registered to — which login, which inbox. Only the person's own address: someone else's
// is their personal detail.
export const ACCOUNT_FIELDS: readonly FieldDef[] = [
  f("account_name", "Account name", "text", { hint: "The name it's in, as the provider shows it." }),
  f("account_email", "Account email", "email", { hint: "The email address it's registered to." }),
];
export const ACCOUNT_FIELD_KEYS: readonly string[] = ACCOUNT_FIELDS.map((field) => field.key);

export const BOOKING_FIELDS: readonly FieldDef[] = [
  f("starts_at", "Starts", "datetime"),
  f("ends_at", "Ends", "datetime"),
  f("place", "Where", "place"),
  f("party_size", "How many", "number", { unit: "people" }),
  f("booked_via", "Booked through"),
  f("deposit", "Deposit", "amount"),
  f("card_held", "Card held", "boolean"),
  f("cancel_by", "Free cancellation until", "datetime"),
  f("hold_until", "Held until", "datetime"),
];
export const CASE_STAGES = ["open", "waiting on them", "waiting on me", "under review", "escalated", "resolved"] as const;
export const CASE_FIELDS: readonly FieldDef[] = [
  f("opened_on", "Opened", "date"),
  f("stage", "Stage", "text", { choices: CASE_STAGES }),
  f("next_step", "Next step"),
  f("waiting_on", "Waiting on"),
  f("outcome", "Outcome"),
];
export const LIFECYCLE_FIELD_KEYS: readonly string[] = [...BOOKING_FIELDS, ...CASE_FIELDS].map((field) => field.key);

// The default reminders of each lifecycle.
const BOOKING_REMINDERS = [1, 0] as const;

/**
 * Merge a kind's own fields with its lifecycle's and the common ones (and, for an account, the
 * account fields beside its number: name, provider, account name, number, account email); a kind's
 * own definition (and its label overrides) win.
 */
export function mergeFields(
  own: readonly FieldDef[],
  lifecycle: Lifecycle,
  labels: Readonly<Record<string, string>> = {},
  account = false,
): FieldDef[] {
  const lifecycleFields = lifecycle === "booking" ? BOOKING_FIELDS : lifecycle === "case" ? CASE_FIELDS : [];
  const ownKeys = new Set(own.map((field) => field.key));
  const merged: FieldDef[] = [];
  const push = (field: FieldDef) => {
    if (merged.some((existing) => existing.key === field.key)) return;
    merged.push(labels[field.key] ? { ...field, label: labels[field.key]! } : field);
  };
  const [name, provider, reference] = COMMON_LEADING as [FieldDef, FieldDef, FieldDef];
  const leading = account ? [name, provider, ACCOUNT_FIELDS[0]!, reference, ACCOUNT_FIELDS[1]!] : [name, provider, reference];
  for (const field of leading) push(ownKeys.has(field.key) ? own.find((o) => o.key === field.key)! : field);
  for (const field of lifecycleFields) push(ownKeys.has(field.key) ? own.find((o) => o.key === field.key)! : field);
  for (const field of own) push(field);
  for (const field of COMMON_TRAILING) push(field);
  return merged;
}

// ---- the built-in categories ---------------------------------------------------------------

const category = (id: string, label: string, lifeArea: LifeArea, icon: CategoryIcon, priority: number, promptWords: string, description: string): CategoryDef =>
  ({ id, label, description, lifeArea, icon, priority, promptWords, origin: "builtin" });

export const BUILT_IN_CATEGORIES: readonly CategoryDef[] = [
  category("home", "Home", "home", "home", 4, "lease or mortgage, home insurance and rates", "Where you live or own: the lease or mortgage, home insurance, rates and levies, and tradies and inspections."),
  category("utilities", "Utilities", "home", "plug", 5, "electricity, gas, internet and phone accounts", "Electricity, gas, water, internet and phone accounts."),
  category("vehicles", "Vehicles", "getting_around", "car", 1, "rego and car insurance", "Cars, motorcycles, caravans and boats, with their rego, insurance and servicing."),
  category("travel", "Trips and travel", "getting_around", "plane", 7, "flights, hotels and trips", "Trips, with their flights, stays, car hire, transfers and travel insurance."),
  category("health", "Health", "health", "heart-pulse", 2, "health insurance and appointments", "Health insurance, ambulance cover, the doctors you see and your appointments. Never diagnoses, results or medicines."),
  category("care", "Care and support", "health", "hand-heart", 18, "NDIS or aged-care plans", "NDIS and aged-care plans and the services that support you or someone you care for."),
  category("banking", "Banking and credit", "money", "landmark", 9, "bank accounts, credit cards and loans", "Banks, credit cards and loans, by name and last 4 digits only."),
  category("investing", "Super and investing", "money", "trending-up", 3, "super fund and investments", "Your super fund, investment accounts and pension."),
  category("government", "Tax and government", "money", "building", 8, "tax, fines and government payments", "Tax returns and BAS, HELP debt, government payments, fines and applications."),
  category("insurance", "Personal insurance", "papers", "shield", 10, "life, income protection and travel insurance", "Life, income protection and travel insurance, and claims."),
  category("id", "ID and residency", "papers", "id-card", 6, "passport, licence and visa expiry dates", "When your passport, licence, Medicare card and visa expire. The numbers stay in your Vault."),
  category("legal", "Legal and estate", "papers", "scroll", 19, "will and power of attorney", "Your will, powers of attorney and directives: that they exist, where they're kept and who's named."),
  category("work", "Work and study", "work", "briefcase", 11, "employer, licences and study", "Your employer, professional licences and registrations, and study."),
  category("business", "Business", "work", "store", 15, "business registrations, insurance and domains", "A business you run: its ABN, registrations, insurance and domains."),
  category("family", "Kids and family", "family", "users", 13, "school, childcare and activities", "Children and family: school and childcare, activities and immunisations due."),
  category("pets", "Pets", "family", "paw-print", 14, "pet insurance, vet and registration", "Your pets, their insurance, vet visits, vaccinations and registration."),
  category("belongings", "Purchases and belongings", "everyday", "shopping-bag", 16, "receipts and warranties", "Things you bought: receipts, return-by dates and warranties, and valuables."),
  category("subscriptions", "Subscriptions and memberships", "everyday", "repeat", 12, "subscriptions, memberships and loyalty programmes", "Streaming, software, memberships, clubs and loyalty programmes."),
  category("outings", "Going out", "everyday", "utensils", 17, "restaurant, event and appointment bookings", "Restaurants, events, haircuts and classes you've booked."),
  category("other", "Other", "everyday", "shapes", 99, "anything else with a date", "Renewals, appointments and anything else."),
];

// ---- the built-in kinds --------------------------------------------------------------------

interface KindSpec {
  readonly key: string;
  readonly label: string;
  readonly use: string;
  readonly lifecycle?: Lifecycle;
  readonly anchor?: true;
  readonly belongsTo?: readonly string[];
  readonly due?: { readonly means: DueMeans; readonly label: string };
  readonly fields?: readonly FieldDef[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly identity?: readonly (readonly string[])[];
  readonly fallbackIdentity?: readonly string[];
  readonly singleton?: true;
  readonly storedKind?: StoredKind;
  readonly reminders?: readonly number[];
  readonly account?: true;
  readonly documentLike?: true;
  readonly defaultMinutes?: number;
}

/** Build a kind definition from a spec (built-in and custom kinds alike). */
export function buildKind(categoryId: string, spec: KindSpec, origin: "builtin" | "custom"): RecordTypeDef {
  const lifecycle = spec.lifecycle ?? "standing";
  // Only something the person holds is an account: not a thing others belong to, an ID document,
  // a booking or a matter in progress.
  const account = Boolean(spec.account) && lifecycle === "standing" && !spec.anchor && !spec.documentLike;
  const identity = spec.identity ?? (lifecycle === "booking" ? [["provider", "reference"], ["provider", "starts_at"]] : lifecycle === "case" ? [["provider", "reference"], ["provider", "opened_on"]] : []);
  return {
    id: `${categoryId}.${spec.key}`,
    category: categoryId,
    label: spec.label,
    use: spec.use,
    lifecycle,
    ...(spec.anchor ? { anchor: true as const } : {}),
    ...(spec.belongsTo ?? (lifecycle !== "standing" ? ["any"] : undefined) ? { belongsTo: spec.belongsTo ?? ["any"] } : {}),
    ...(spec.due ? { due: spec.due } : lifecycle === "booking" ? { due: { means: "starts" as const, label: "Starts" } } : {}),
    fields: mergeFields(spec.fields ?? [], lifecycle, spec.labels, account),
    identity,
    ...(spec.fallbackIdentity ? { fallbackIdentity: spec.fallbackIdentity } : {}),
    ...(spec.singleton ? { singleton: true as const } : {}),
    storedKind: spec.storedKind ?? "item",
    ...(spec.reminders ? { reminders: spec.reminders } : lifecycle === "booking" ? { reminders: BOOKING_REMINDERS } : {}),
    ...(account ? { account: true as const } : {}),
    ...(spec.documentLike ? { documentLike: true as const } : {}),
    ...(lifecycle === "booking" ? { defaultMinutes: spec.defaultMinutes ?? 60 } : {}),
    origin,
  };
}

const ins = { provider: "Insurer", reference: "Policy number", amount: "Premium" };
const policy: readonly (readonly string[])[] = [["provider", "reference"]];
const cover = (choices: readonly string[]) => f("cover", "Cover", "text", { choices });

const KINDS: Readonly<Record<string, readonly KindSpec[]>> = {
  home: [
    { key: "property", label: "Home", anchor: true, use: "A place you live in or own. Its lease or mortgage, insurance, rates, utilities and tradies belong to it.", fields: [f("address", "Address", "place"), f("role", "Your role", "text", { choices: ["renter", "owner", "strata owner", "landlord"] })], labels: { name: "Name, for example Home" }, identity: [["address"]] },
    { key: "lease", account: true, label: "Lease", belongsTo: ["home.property"], use: "A rental lease: rent, when it ends, the agent and the bond.", due: { means: "ends", label: "Lease ends" }, reminders: [90, 30], fields: [f("starts_on", "Started", "date"), f("bond", "Bond", "amount"), f("bond_reference", "Bond number", "reference")], labels: { provider: "Agent or landlord", amount: "Rent" }, identity: [["parent"]] },
    { key: "mortgage", account: true, label: "Mortgage", belongsTo: ["home.property"], use: "A home loan: the lender, rate and when a fixed rate ends.", due: { means: "ends", label: "Fixed rate ends" }, reminders: [60, 14], fields: [f("last4", "Loan account (last 4)", "last4"), f("rate", "Interest rate"), f("rate_type", "Rate type", "text", { choices: ["variable", "fixed", "split"] })], labels: { provider: "Lender", amount: "Repayment" }, identity: [["provider", "last4"]], fallbackIdentity: ["provider", "name"] },
    { key: "insurance", account: true, label: "Home insurance", belongsTo: ["home.property"], use: "Building, contents, landlord or renters insurance.", due: { means: "renews", label: "Renews" }, reminders: [30, 7], fields: [cover(["building", "contents", "building and contents", "landlord", "renters"]), f("sum_insured", "Sum insured", "amount"), f("excess", "Excess", "amount"), f("claims_phone", "Claims phone", "phone")], labels: ins, identity: policy },
    { key: "rates", account: true, label: "Rates or levies", belongsTo: ["home.property"], use: "Council rates, strata levies, water rates or land tax.", due: { means: "due", label: "Next instalment" }, reminders: [14, 3], fields: [f("rates_kind", "What", "text", { choices: ["council rates", "strata levies", "water rates", "land tax"] })], labels: { provider: "Council or strata manager", reference: "Assessment or lot number" }, identity: policy },
    { key: "visit", label: "Tradie or inspection", lifecycle: "booking", use: "A tradie, cleaner, inspection or open home booked at the home.", defaultMinutes: 120, fields: [f("visit_kind", "What", "text", { choices: ["tradie", "cleaner", "inspection", "open home"] }), f("job", "Job")], labels: { provider: "Who's coming" } },
    { key: "repair", label: "Repair request", lifecycle: "case", use: "A repair or maintenance request with the landlord, agent or strata.", fields: [f("issue", "Issue")], labels: { provider: "Agent, landlord or tradie", reference: "Request number" } },
  ],
  utilities: [
    { key: "energy", account: true, label: "Electricity or gas", belongsTo: ["home.property"], use: "An electricity or gas account.", due: { means: "ends", label: "Plan or discount ends" }, reminders: [30], fields: [f("service", "Service", "text", { choices: ["electricity", "gas"] }), f("plan", "Plan"), f("meter_id", "NMI or MIRN")], labels: { provider: "Retailer", reference: "Account number", amount: "Typical bill" }, identity: policy },
    { key: "water", account: true, label: "Water", belongsTo: ["home.property"], use: "A water account.", labels: { reference: "Account number", amount: "Typical bill" }, identity: policy },
    { key: "internet", account: true, label: "Internet", belongsTo: ["home.property"], use: "An NBN or other internet plan.", due: { means: "ends", label: "Contract ends" }, reminders: [30], fields: [f("plan", "Plan")], labels: { reference: "Account number" }, identity: policy },
    { key: "phone", account: true, label: "Phone", use: "A mobile or home phone plan.", due: { means: "ends", label: "Contract ends" }, reminders: [30], fields: [f("plan", "Plan"), f("phone_number", "Phone number", "phone")], labels: { reference: "Account number" }, identity: policy },
  ],
  vehicles: [
    { key: "vehicle", label: "Vehicle", anchor: true, use: "A car, motorcycle, caravan, trailer or boat. Its rego, insurance, servicing and bookings belong to it.", fields: [f("body", "Type", "text", { choices: ["car", "motorcycle", "van", "truck", "caravan", "trailer", "boat"] }), f("make", "Make"), f("model", "Model"), f("year", "Year", "number"), f("plate", "Number plate"), f("state", "State", "text", { choices: STATES }), f("vin", "VIN")], labels: { name: "Nickname or make and model" }, identity: [["plate"], ["vin"]] },
    { key: "registration", account: true, label: "Registration", belongsTo: ["vehicles.vehicle"], use: "A vehicle's rego: when it expires, what it costs, and the CTP (green slip) insurer.", due: { means: "expires", label: "Expires" }, reminders: [30, 7], fields: [f("plate", "Number plate"), f("state", "State", "text", { choices: STATES }), f("term", "Term", "text", { choices: ["3 months", "6 months", "12 months"] }), f("ctp_insurer", "CTP or green slip insurer"), f("inspection", "Inspection needed", "text", { hint: "For example a pink slip or safety certificate." })], labels: { provider: "Registration authority", reference: "Billing or customer number", amount: "Renewal cost" }, identity: [["plate"], ["parent"]] },
    { key: "insurance", account: true, label: "Vehicle insurance", belongsTo: ["vehicles.vehicle"], use: "Comprehensive or third-party insurance for a vehicle.", due: { means: "renews", label: "Renews" }, reminders: [30, 7], fields: [cover(["comprehensive", "third party fire and theft", "third party property"]), f("sum_insured", "Sum insured", "amount"), f("excess", "Excess", "amount"), f("claims_phone", "Claims phone", "phone")], labels: ins, identity: policy },
    { key: "service", label: "Servicing", belongsTo: ["vehicles.vehicle"], use: "When a vehicle's next service is due and who services it.", due: { means: "due", label: "Next service" }, reminders: [14], fields: [f("last_service", "Last service", "date"), f("odometer", "Odometer at last service", "number", { unit: "km" })], labels: { provider: "Workshop" }, identity: [["parent"]] },
    { key: "roadside", account: true, label: "Roadside assistance", belongsTo: ["vehicles.vehicle"], use: "Roadside assistance membership, such as NRMA, RACV or RACQ.", due: { means: "renews", label: "Renews" }, fields: [f("tier", "Level")], labels: { reference: "Member number", contact: "Assistance phone" }, identity: policy },
    { key: "toll", account: true, label: "Toll account", belongsTo: ["vehicles.vehicle"], use: "A toll account or e-TAG.", labels: { provider: "Toll provider", reference: "Account number" }, identity: policy },
    { key: "booking", label: "Vehicle booking", lifecycle: "booking", use: "A service, pink slip, tyre or repair booking for a vehicle.", defaultMinutes: 240, fields: [f("booking_kind", "What", "text", { choices: ["service", "pink slip", "safety check", "tyres", "repair"] }), f("loan_car", "Loan car", "boolean")], labels: { provider: "Workshop" } },
  ],
  travel: [
    { key: "trip", label: "Trip", anchor: true, lifecycle: "booking", use: "A trip away. Its flights, stays, car hire, transfers, tours and travel insurance belong to it; its dates come from them.", due: { means: "starts", label: "Starts" }, reminders: [7], defaultMinutes: 1440, fields: [f("destination", "Destination", "place")], labels: { name: "Trip name" }, identity: [["name"]] },
    { key: "flight", label: "Flight", lifecycle: "booking", use: "One flight (one leg). Save a return trip as two flights.", defaultMinutes: 240, fields: [f("flight_number", "Flight number"), f("from", "From", "place"), f("to", "To", "place"), f("seat", "Seat"), f("cabin", "Cabin", "text", { choices: ["economy", "premium economy", "business", "first"] })], labels: { provider: "Airline", reference: "Booking reference" }, identity: [["reference", "flight_number", "starts_at"], ["flight_number", "starts_at"]] },
    { key: "stay", label: "Stay", lifecycle: "booking", use: "A hotel, Airbnb or other place to stay.", defaultMinutes: 1440, fields: [f("room", "Room")], labels: { provider: "Property or platform", reference: "Confirmation number" } },
    { key: "car_hire", label: "Car hire", lifecycle: "booking", use: "A hire car.", defaultMinutes: 1440, fields: [f("car_class", "Car"), f("pickup", "Pick up", "place"), f("dropoff", "Drop off", "place")], labels: { provider: "Hire company", reference: "Confirmation number" } },
    { key: "transport", label: "Transfer or ticket", lifecycle: "booking", use: "A train, bus, ferry, transfer or rideshare booking.", fields: [f("mode", "Mode", "text", { choices: ["train", "bus", "ferry", "transfer", "rideshare"] }), f("from", "From", "place"), f("to", "To", "place")], labels: { provider: "Operator" } },
    { key: "tour", label: "Tour or activity", lifecycle: "booking", use: "A tour or activity on a trip.", defaultMinutes: 180, labels: { provider: "Operator" } },
    { key: "insurance", account: true, label: "Trip insurance", belongsTo: ["travel.trip"], use: "Travel insurance for one trip.", due: { means: "ends", label: "Cover ends" }, reminders: [7], fields: [f("region", "Where"), f("emergency_phone", "Emergency phone", "phone"), f("excess", "Excess", "amount")], labels: ins, identity: policy },
  ],
  health: [
    { key: "insurance", account: true, label: "Health insurance", use: "Private health cover: the fund, hospital and extras cover, and who is covered.", due: { means: "renews", label: "Renews or extras reset" }, reminders: [45], fields: [f("hospital_cover", "Hospital cover", "text", { choices: ["gold", "silver plus", "silver", "bronze plus", "bronze", "basic", "none"] }), f("extras_cover", "Extras cover"), f("excess", "Excess", "amount"), f("scale", "Who is covered", "text", { choices: ["single", "couple", "family", "single parent"] }), f("ambulance", "Ambulance cover")], labels: { provider: "Fund", reference: "Membership number", amount: "Premium" }, identity: policy },
    { key: "ambulance", account: true, label: "Ambulance cover", use: "Ambulance cover bought separately from health insurance.", due: { means: "renews", label: "Renews" }, labels: { reference: "Membership number" }, identity: policy },
    { key: "provider", label: "Doctor or provider", use: "A GP, dentist, specialist or other provider the person sees, and when the next visit is due. Never diagnoses, medicines or results.", due: { means: "due", label: "Next visit" }, reminders: [14], fields: [f("provider_kind", "Kind", "text", { choices: ["GP", "dentist", "specialist", "physio", "optometrist", "psychologist", "pharmacy"] })], labels: { name: "Doctor or provider", provider: "Practice" }, identity: [["provider", "name"]] },
    { key: "script", label: "Script repeat", use: "When a script's next repeat is due. Never the medicine itself.", due: { means: "due", label: "Repeat due" }, reminders: [7], fields: [f("repeats_left", "Repeats left", "number")], labels: { name: "What to call it", provider: "Pharmacy" } },
    { key: "appointment", label: "Health appointment", lifecycle: "booking", use: "A GP, dental, specialist, physio or other health appointment.", fields: [f("appointment_kind", "Kind", "text", { choices: ["GP", "dentist", "specialist", "physio", "optometrist", "psychologist", "pathology", "imaging"] }), f("telehealth", "Telehealth", "boolean")], labels: { provider: "Clinic or practitioner" } },
    { key: "referral", label: "Referral", lifecycle: "case", use: "A referral to a specialist, and when it expires.", due: { means: "expires", label: "Referral expires" }, labels: { provider: "Referred to" } },
  ],
  care: [
    { key: "plan", label: "Support plan", use: "An NDIS plan, aged-care plan or home care package, and when it's reviewed.", due: { means: "due", label: "Plan review" }, reminders: [60, 14], fields: [f("plan_kind", "Kind", "text", { choices: ["NDIS", "aged care", "home care package"] }), f("plan_manager", "Plan manager")], labels: { provider: "Agency" }, identity: [["plan_kind"]] },
    { key: "service", label: "Support service", use: "A support provider or service agreement.", due: { means: "ends", label: "Agreement ends" }, fields: [f("service_kind", "Service")], labels: { reference: "Agreement number" }, identity: policy },
  ],
  banking: [
    { key: "account", account: true, label: "Bank account", use: "A bank or savings account: the bank and the last 4 digits only. Never the BSB and full account number.", due: { means: "ends", label: "Rate or term ends" }, fields: [f("account_kind", "Kind", "text", { choices: ["everyday", "savings", "offset", "term deposit"] }), f("last4", "Account (last 4)", "last4"), f("rate", "Interest rate")], labels: { provider: "Bank" }, identity: [["provider", "last4"]], fallbackIdentity: ["provider", "name"] },
    { key: "card", account: true, label: "Credit card", use: "A credit card's issuer, last 4 digits, expiry and annual fee date. Never the card number.", due: { means: "due", label: "Annual fee" }, reminders: [30], fields: [f("card_product", "Card"), f("last4", "Card (last 4)", "last4"), f("card_expiry", "Card expires", "month_year"), f("annual_fee", "Annual fee", "amount"), f("promo_ends", "Interest-free or balance transfer ends", "date")], labels: { provider: "Issuer" }, identity: [["provider", "last4"]], fallbackIdentity: ["provider", "name"] },
    { key: "loan", account: true, label: "Loan", use: "A car, personal or student loan, novated lease or buy-now-pay-later plan.", due: { means: "ends", label: "Ends or fixed rate ends" }, reminders: [60], fields: [f("loan_kind", "Kind", "text", { choices: ["car", "personal", "novated lease", "buy now pay later"] }), f("last4", "Account (last 4)", "last4"), f("rate", "Interest rate")], labels: { provider: "Lender", amount: "Repayment" }, identity: [["provider", "last4"]], fallbackIdentity: ["provider", "name"] },
    { key: "application", label: "Application", lifecycle: "case", use: "A card, account or loan application in progress.", fields: [f("application_kind", "For")], labels: { provider: "Bank or lender" } },
  ],
  investing: [
    { key: "super", account: true, label: "Super fund", use: "A superannuation fund: the fund, member number and USI a new employer asks for.", fields: [f("product", "Product", "text", { hint: "For example MySuper, Choice or Pension." }), f("usi", "USI"), f("fund_abn", "Fund ABN"), f("employer", "Employer paying into it"), f("insurance_in_super", "Insurance inside super")], labels: { provider: "Fund", reference: "Member number" }, identity: policy },
    { key: "investment", account: true, label: "Investment account", use: "A share broker, crypto exchange or managed fund account.", fields: [f("investment_kind", "Kind", "text", { choices: ["broker", "crypto exchange", "managed fund", "micro-investing"] })], labels: { provider: "Platform", reference: "Account number" }, identity: policy },
    { key: "pension", account: true, label: "Pension", use: "An age pension or super income stream.", due: { means: "due", label: "Next review" }, labels: { provider: "Paid by" }, identity: [["provider"]] },
  ],
  government: [
    { key: "lodgement", label: "Tax lodgement", use: "A tax return, BAS or instalment due date. Never a tax file number.", due: { means: "due", label: "Due" }, reminders: [30, 7], fields: [f("lodgement_kind", "What", "text", { choices: ["tax return", "BAS", "IAS", "PAYG instalment"] }), f("period", "Period", "text", { hint: "For example FY2026." })], labels: { provider: "Tax agent" }, identity: [["lodgement_kind", "period"]] },
    { key: "help", label: "HELP debt", use: "A HELP or other study loan balance.", labels: { amount: "Balance" }, singleton: true, identity: [] },
    { key: "payment", label: "Government payment", use: "A Centrelink or carer payment and when reporting is due. Never the customer reference number.", due: { means: "due", label: "Next report due" }, fields: [f("payment_kind", "Payment")], labels: { provider: "Agency" }, identity: [["payment_kind"]] },
    { key: "fine", label: "Fine", lifecycle: "case", use: "A fine or penalty, and when it must be paid or reviewed.", due: { means: "due", label: "Pay by" }, reminders: [14, 3], fields: [f("issued_on", "Issued", "date")], labels: { provider: "Issued by", reference: "Notice number", amount: "Amount" } },
    { key: "application", label: "Government application", lifecycle: "case", use: "A passport, visa, licence, citizenship or benefit application in progress.", due: { means: "due", label: "Decision expected" }, fields: [f("application_kind", "For")], labels: { provider: "Agency", reference: "Application number" } },
    { key: "appointment", label: "Government appointment", lifecycle: "booking", use: "An appointment with a government agency, post office or service centre.", labels: { provider: "Agency" } },
  ],
  insurance: [
    { key: "life", account: true, label: "Life or income protection", use: "Life, TPD, trauma, income protection or funeral cover, including cover held inside super.", due: { means: "renews", label: "Anniversary" }, reminders: [30], fields: [f("covers", "What it covers"), f("benefit", "Benefit"), f("held_in_super", "Held inside super", "boolean")], labels: ins, identity: policy },
    { key: "travel", account: true, label: "Annual travel insurance", use: "An annual or multi-trip travel insurance policy.", due: { means: "renews", label: "Renews" }, reminders: [30], fields: [f("region", "Where"), f("emergency_phone", "Emergency phone", "phone")], labels: ins, identity: policy },
    { key: "other", account: true, label: "Other insurance", belongsTo: ["any"], use: "Any other insurance policy, including one for a thing in a category of your own.", due: { means: "renews", label: "Renews" }, reminders: [30, 7], fields: [f("covers", "What it covers")], labels: ins, identity: policy },
    { key: "claim", label: "Insurance claim", lifecycle: "case", use: "An insurance claim in progress, for any policy.", fields: [f("policy", "Policy")], labels: { provider: "Insurer", reference: "Claim number" } },
  ],
  id: [
    { key: "passport", label: "Passport", documentLike: true, use: "When a passport expires. Never the passport number: the person keeps it in their Vault.", due: { means: "expires", label: "Expires" }, reminders: [270, 180], fields: [f("country", "Country"), f("issued_on", "Issued", "date")], identity: [["country", "for_whom"], ["country"]] },
    { key: "driver_licence", label: "Driver or rider licence", documentLike: true, use: "When a driver, rider or boat licence expires, and its class. Never the licence or card number.", due: { means: "expires", label: "Expires" }, reminders: [60, 14], fields: [f("state", "State", "text", { choices: STATES }), f("licence_class", "Class", "text", { hint: "For example C, R or a boat licence." }), f("conditions", "Conditions")], identity: [["state"]] },
    { key: "medicare", label: "Medicare card", documentLike: true, use: "When the Medicare card expires and who is on it. Never the card number.", due: { means: "expires", label: "Valid to" }, reminders: [30], fields: [f("people", "People on the card")], identity: [], singleton: true },
    { key: "visa", label: "Visa", documentLike: true, use: "A visa or travel authorisation and when it expires. Never the grant number.", due: { means: "expires", label: "Expires or enter by" }, reminders: [90, 30], fields: [f("country", "Country"), f("visa_type", "Visa type or subclass"), f("conditions", "Conditions")], identity: [["country", "visa_type"]] },
    { key: "check", label: "Working with children or police check", use: "A working with children check, police check or NDIS screening and when it expires.", due: { means: "expires", label: "Expires" }, reminders: [90], fields: [f("check_kind", "Kind", "text", { choices: ["working with children", "police check", "NDIS screening"] }), f("state", "State", "text", { choices: STATES })], labels: { reference: "Check number" }, identity: [["check_kind", "state"]] },
  ],
  legal: [
    { key: "document", label: "Legal document", use: "A will, power of attorney or advance care directive: that it exists, where it's kept and who's named. Never its contents.", due: { means: "due", label: "Review by" }, fields: [f("document_kind", "What", "text", { choices: ["will", "power of attorney", "guardianship", "advance care directive"] }), f("kept_at", "Kept at"), f("named_person", "Executor or attorney", "person")], labels: { provider: "Lawyer" }, identity: [["document_kind", "for_whom"], ["document_kind"]] },
  ],
  work: [
    { key: "job", label: "Job", use: "An employer, role and payroll contact.", due: { means: "ends", label: "Contract ends" }, fields: [f("role", "Role"), f("starts_on", "Started", "date")], labels: { provider: "Employer", contact: "Payroll or HR contact" }, identity: [["provider"]] },
    { key: "licence", label: "Licence or registration", use: "A professional registration, trade licence or certificate (AHPRA, RSA, white card, first aid) and when it expires.", due: { means: "expires", label: "Expires" }, reminders: [60, 14], fields: [f("licence_kind", "What")], labels: { provider: "Issuing body", reference: "Registration number" }, identity: policy },
    { key: "study", label: "Study", use: "A course: the institution, student number and census date.", due: { means: "due", label: "Census date" }, reminders: [14, 3], fields: [f("course", "Course")], labels: { provider: "Institution", reference: "Student number" }, identity: [["provider", "course"]] },
  ],
  business: [
    { key: "entity", label: "Business", anchor: true, use: "A business the person runs. Its registrations, insurance and domains belong to it.", fields: [f("structure", "Structure", "text", { choices: ["sole trader", "company", "partnership", "trust"] }), f("abn", "ABN")], labels: { name: "Business name" }, identity: [["abn"], ["name"]] },
    { key: "registration", account: true, label: "Business registration", belongsTo: ["business.entity"], use: "A business name registration or ASIC annual review.", due: { means: "renews", label: "Renews" }, reminders: [30], fields: [f("registration_kind", "What", "text", { choices: ["business name", "ASIC annual review", "licence"] })], labels: { provider: "Registry" }, identity: [["registration_kind", "parent"]] },
    { key: "insurance", account: true, label: "Business insurance", belongsTo: ["business.entity"], use: "Public liability, professional indemnity or other business insurance.", due: { means: "renews", label: "Renews" }, reminders: [30, 7], fields: [cover(["public liability", "professional indemnity", "business pack"])], labels: ins, identity: policy },
    { key: "domain", account: true, label: "Domain or hosting", belongsTo: ["any"], use: "A domain name, hosting or cloud account and when it renews.", due: { means: "renews", label: "Renews" }, reminders: [30], fields: [f("domain_name", "Domain")], labels: { provider: "Registrar or host" }, identity: [["domain_name"], ["provider", "reference"]] },
  ],
  family: [
    { key: "child", label: "Child", anchor: true, use: "A child (first name only). Their school, activities and immunisations belong to them.", fields: [f("school", "School"), f("year_level", "Year")], labels: { name: "First name" }, identity: [["name"]] },
    { key: "school", label: "School or childcare", belongsTo: ["family.child"], use: "A school, childcare or OSHC enrolment, and the Child Care Subsidy percentage.", due: { means: "due", label: "Fees due" }, fields: [f("school_kind", "Kind", "text", { choices: ["school", "childcare", "OSHC"] }), f("ccs_percent", "Child Care Subsidy", "number", { unit: "%" })], labels: { provider: "School or centre" }, identity: [["provider", "parent"]] },
    { key: "activity", label: "Activity", belongsTo: ["family.child"], use: "A sport, club or lesson and when its fees are due.", due: { means: "due", label: "Fees due" }, labels: { provider: "Club or activity" }, identity: [["provider", "parent"]] },
    { key: "immunisation", label: "Immunisations due", belongsTo: ["family.child"], use: "When the next scheduled immunisations are due.", due: { means: "due", label: "Due" }, reminders: [30, 7], labels: { name: "What's due" }, identity: [["parent", "name"]] },
  ],
  pets: [
    { key: "pet", label: "Pet", anchor: true, use: "A pet. Its insurance, vaccinations, registration and vet visits belong to it.", fields: [f("species", "Species"), f("breed", "Breed"), f("born_on", "Born", "date"), f("microchip", "Microchip number")], labels: { provider: "Vet clinic", contact: "Vet phone" }, identity: [["name"], ["microchip"]] },
    { key: "insurance", account: true, label: "Pet insurance", belongsTo: ["pets.pet"], use: "A pet insurance policy.", due: { means: "renews", label: "Renews" }, reminders: [30], fields: [cover([])], labels: ins, identity: policy },
    { key: "care", label: "Vaccination or treatment", belongsTo: ["pets.pet"], use: "A vaccination, heartworm, flea or worm treatment and when it is next due.", due: { means: "due", label: "Next due" }, reminders: [14], fields: [f("care_kind", "What"), f("last_done", "Last done", "date")], labels: { provider: "Clinic" }, identity: [["parent", "care_kind"]] },
    { key: "registration", label: "Council registration", belongsTo: ["pets.pet"], use: "A pet's council registration.", due: { means: "renews", label: "Renews" }, reminders: [30], labels: { provider: "Council", reference: "Registration number" }, identity: [["parent"]] },
    { key: "appointment", label: "Vet or pet booking", lifecycle: "booking", use: "A vet, groomer or boarding booking.", fields: [f("appointment_kind", "What", "text", { choices: ["vet", "groomer", "boarding"] })], labels: { provider: "Vet, groomer or boarding" } },
  ],
  belongings: [
    { key: "receipt", label: "Receipt or warranty", storedKind: "receipt_warranty", belongsTo: ["any"], use: "Something bought: when it can be returned and when its warranty ends.", due: { means: "return_by", label: "Return by" }, reminders: [7], fields: [f("item", "Item"), f("order_number", "Order number", "reference"), f("purchased_on", "Bought", "date"), f("warranty_ends", "Warranty ends", "date"), f("serial_number", "Serial number")], labels: { provider: "Merchant", amount: "Price" }, identity: [["provider", "order_number"]] },
    { key: "valuable", label: "Valuable", anchor: true, use: "Something valuable you own, with its serial number and value. Its insurance can belong to it.", fields: [f("item", "Item"), f("serial_number", "Serial number"), f("value", "Value", "amount")], identity: [["serial_number"], ["name"]] },
  ],
  subscriptions: [
    { key: "service", account: true, label: "Subscription", storedKind: "subscription", belongsTo: ["any"], use: "Streaming, software, a box or anything else billed on repeat.", due: { means: "renews", label: "Renews" }, fields: [f("plan", "Plan"), f("trial_ends", "Free trial ends", "date"), f("paid_with", "Paid with", "text", { hint: "For example Visa ending 1234." }), f("how_to_cancel", "How to cancel")], labels: { provider: "Service", reference: "Account number" }, identity: [["title"]] },
    { key: "membership", account: true, label: "Membership", belongsTo: ["any"], storedKind: "subscription", use: "A gym, club, professional association or other membership.", due: { means: "renews", label: "Renews" }, reminders: [30], fields: [f("tier", "Level"), f("how_to_cancel", "How to cancel")], labels: { provider: "Organisation", reference: "Member number" }, identity: policy },
    { key: "loyalty", account: true, label: "Loyalty programme", use: "A frequent flyer or loyalty programme: member number, tier and when points expire.", due: { means: "expires", label: "Points expire" }, fields: [f("tier", "Tier"), f("points", "Points", "number")], labels: { provider: "Programme", reference: "Member number" }, identity: policy },
  ],
  outings: [
    { key: "restaurant", label: "Restaurant", lifecycle: "booking", use: "A restaurant, bar or venue booking.", defaultMinutes: 120, labels: { provider: "Restaurant" } },
    { key: "event", label: "Event or tickets", lifecycle: "booking", use: "Concert, theatre, sport, cinema or other event tickets.", defaultMinutes: 180, fields: [f("seats", "Seats")], labels: { provider: "Venue or ticketing" } },
    { key: "beauty", label: "Hair or beauty", lifecycle: "booking", use: "A haircut, beauty or massage appointment.", fields: [f("service", "Service")], labels: { provider: "Salon" } },
    { key: "class", label: "Class", lifecycle: "booking", use: "A class, lesson or workshop.", labels: { provider: "Studio or teacher" } },
    { key: "invitation", label: "Invitation", lifecycle: "booking", use: "An invitation to reply to: a wedding, party or event.", defaultMinutes: 240, fields: [f("rsvp_by", "Reply by", "date")], labels: { provider: "From" }, identity: [["provider", "starts_at"]] },
  ],
  other: [
    { key: "reminder", label: "Renewal or appointment", storedKind: "renewal_appointment", use: "A renewal or appointment that fits no other kind.", due: { means: "due", label: "Due" }, fields: [f("where", "Where")], labels: { name: "What" } },
    { key: "item", label: "Something else", belongsTo: ["any"], use: "Anything else worth keeping track of.", due: { means: "due", label: "Due" }, labels: { name: "What" } },
    { key: "appointment", label: "Appointment or meeting", lifecycle: "booking", use: "A meeting, inspection or appointment that fits no other kind.", labels: { provider: "With" } },
    { key: "case", label: "Matter in progress", lifecycle: "case", use: "A dispute, refund, appeal or anything else in progress that fits no other kind.", labels: { provider: "With" } },
  ],
};

export const BUILT_IN_TYPES: readonly RecordTypeDef[] = BUILT_IN_CATEGORIES.flatMap((cat) =>
  (KINDS[cat.id] ?? []).map((spec) => buildKind(cat.id, spec, "builtin")),
);

// The type a record saved under one of the three original kinds (before types existed) reads as.
export const LEGACY_KIND_TYPES: Readonly<Record<StoredKind, string>> = {
  subscription: "subscriptions.service",
  receipt_warranty: "belongings.receipt",
  renewal_appointment: "other.reminder",
  item: "other.item",
};

export type { KindSpec };
