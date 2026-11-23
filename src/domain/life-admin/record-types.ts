// The life-admin record types (docs/adr/life-admin-profile.md): the categories of a person's
// life admin, the types of record in each, and the fields each type keeps.
//
// Warthog never calls an AI model, so the structure an agent fills in has to come from here.
// The same catalogue validates what agents save, labels what the person sees, writes the
// "Life admin" built-in skill agents read, and decides which fields identify one record so a
// second scan of the same email updates it instead of adding a copy.
//
// Deliberately not granular: a handful of categories, a few types each, and only the fields
// people actually ask about. Government identifiers (passport, licence and Medicare numbers)
// are NOT fields of any type: they belong in the device-held vault, and
// `./identifiers.ts` refuses them. Every field here is everyday personal content, stored
// encrypted under the person's data key and shared with the agents they allow.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

export const CATEGORY_IDS = [
  "vehicle",
  "home",
  "utility",
  "insurance",
  "health",
  "money",
  "id",
  "work",
  "subscription",
  "pet",
  "purchase",
  "general",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface CategoryDef {
  readonly id: CategoryId;
  readonly label: string;
  // One line for the person and agents: what belongs here.
  readonly description: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  { id: "vehicle", label: "Vehicles", description: "Cars, motorcycles, boats and trailers, with their rego, insurance and servicing." },
  { id: "home", label: "Home", description: "Where you live: the lease or mortgage, home insurance, and council rates or strata levies." },
  { id: "utility", label: "Utilities", description: "Electricity, gas, water, internet and phone accounts." },
  { id: "insurance", label: "Other insurance", description: "Life, income protection, travel and other policies not tied to a vehicle, home or pet." },
  { id: "health", label: "Health", description: "Health insurance, ambulance cover and the doctors and providers you see." },
  { id: "money", label: "Money & super", description: "Your super fund, banks, credit cards, loans and tax dates." },
  { id: "id", label: "ID documents", description: "Passport, licence, Medicare and visa expiry dates. The numbers stay in your Vault." },
  { id: "work", label: "Work & study", description: "Your employer, professional licences and registrations, and study." },
  { id: "subscription", label: "Subscriptions", description: "Streaming, software, memberships and anything else that renews." },
  { id: "pet", label: "Pets", description: "Your pets, their insurance, vaccinations and council registration." },
  { id: "purchase", label: "Receipts & warranties", description: "Things you bought, when they can be returned and when the warranty ends." },
  { id: "general", label: "Other", description: "Renewals, appointments and anything else with a date." },
];

// The stored plaintext kind (db/migrations/0033 + 0117). The three original kinds keep
// meaning what they did; every other type is stored as `item`, so the plaintext column never
// says which category a record is in (health, ID documents …) — the type lives encrypted.
export type StoredKind = "subscription" | "receipt_warranty" | "renewal_appointment" | "item";

// What a record's due date means for this type, so an agent can say "expires" or "renews".
export type DueMeans = "expires" | "renews" | "due" | "ends" | "return_by";

export type FieldKind =
  | "text" // a short line
  | "long_text" // notes
  | "date" // YYYY-MM-DD
  | "amount" // a plain number, e.g. 412.50
  | "currency" // ISO 4217, e.g. AUD
  | "cycle" // how often a cost recurs
  | "reference" // a policy, account or member number (not a government identifier)
  | "last4" // only the last four characters are kept
  | "phone"
  | "website"; // kept as the site's name only (example.com.au), never a full link

export interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  // Suggested values the form offers; any other value is still accepted.
  readonly choices?: readonly string[];
  readonly hint?: string;
}

export interface RecordTypeDef {
  // `category.type`, e.g. "vehicle.registration".
  readonly id: string;
  readonly category: CategoryId;
  readonly label: string;
  // One line for agents: what this type is for.
  readonly use: string;
  // Other records can belong to this one (a vehicle, a home, a pet).
  readonly asset?: true;
  // The asset types a record of this type may belong to.
  readonly parents?: readonly string[];
  // What the due date means, and how the person sees it ("Expires").
  readonly due?: { readonly means: DueMeans; readonly label: string };
  readonly fields: readonly FieldDef[];
  // The fields whose values identify one record of this type, so saving the same thing again
  // updates it. "parent" stands for the record it belongs to. Empty ⇒ never matched.
  readonly identity: readonly string[];
  // One record of this type per person (a Medicare card).
  readonly singleton?: true;
  readonly storedKind: StoredKind;
  // Default reminder offsets, in days before the due date.
  readonly reminders?: readonly number[];
}

// ---- field helpers -----------------------------------------------------------------------

const f = (key: string, label: string, kind: FieldKind = "text", extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind, ...extra });

const name = (label = "Name") => f("name", label);
const provider = (label: string) => f("provider", label);
const reference = (label: string) => f("reference", label, "reference");
const contact = (label = "Phone or how to contact") => f("contact", label, "phone");
const website = () => f("website", "Website", "website");
const notes = () => f("notes", "Notes", "long_text");
const last4 = (label: string) => f("last4", label, "last4", { hint: "Only the last 4 characters are kept." });
const cost = (label = "Cost"): FieldDef[] => [
  f("amount", label, "amount"),
  f("currency", "Currency", "currency"),
  f("cycle", "How often", "cycle"),
];
const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const;

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

// ---- the types ---------------------------------------------------------------------------

export const RECORD_TYPES: readonly RecordTypeDef[] = [
  // Vehicles
  {
    id: "vehicle.vehicle", category: "vehicle", label: "Vehicle", asset: true, storedKind: "item",
    use: "A car, motorcycle, boat, trailer or caravan. Save it first; its rego, insurance and servicing belong to it.",
    fields: [name("Nickname or make and model"), f("body", "Type", "text", { choices: ["car", "motorcycle", "van", "truck", "boat", "trailer", "caravan"] }), f("make", "Make"), f("model", "Model"), f("year", "Year"), f("plate", "Number plate"), f("state", "State", "text", { choices: STATES }), f("vin", "VIN"), notes()],
    identity: ["plate"],
  },
  {
    id: "vehicle.registration", category: "vehicle", label: "Registration", storedKind: "item", parents: ["vehicle.vehicle"],
    use: "A vehicle's rego: when it expires, what it costs, and the CTP (green slip) insurer.",
    due: { means: "expires", label: "Expires" }, reminders: [30, 7],
    fields: [f("plate", "Number plate"), f("state", "State", "text", { choices: STATES }), provider("Registration authority"), reference("Billing or customer number"), ...cost("Renewal cost"), f("term", "Term", "text", { choices: ["3 months", "6 months", "12 months"] }), f("ctp_insurer", "CTP or green slip insurer"), f("inspection", "Inspection needed", "text", { hint: "For example a pink slip or safety certificate." }), notes()],
    identity: ["plate"],
  },
  {
    id: "vehicle.insurance", category: "vehicle", label: "Vehicle insurance", storedKind: "item", parents: ["vehicle.vehicle"],
    use: "Comprehensive or third-party insurance for a vehicle.",
    due: { means: "renews", label: "Renews" }, reminders: [30, 7],
    fields: [provider("Insurer"), reference("Policy number"), f("cover", "Cover", "text", { choices: ["comprehensive", "third party fire and theft", "third party property"] }), f("sum_insured", "Sum insured", "amount"), f("excess", "Excess", "amount"), ...cost("Premium"), f("claims_phone", "Claims phone", "phone"), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "vehicle.service", category: "vehicle", label: "Servicing", storedKind: "item", parents: ["vehicle.vehicle"],
    use: "When a vehicle's next service is due and who services it.",
    due: { means: "due", label: "Next service" }, reminders: [14],
    fields: [provider("Workshop"), f("last_service", "Last service", "date"), f("odometer", "Odometer at last service"), contact(), notes()],
    identity: ["parent"],
  },
  {
    id: "vehicle.roadside", category: "vehicle", label: "Roadside assistance", storedKind: "item", parents: ["vehicle.vehicle"],
    use: "Roadside assistance membership, such as NRMA, RACV or RACQ.",
    due: { means: "renews", label: "Renews" },
    fields: [provider("Provider"), reference("Member number"), f("tier", "Level"), ...cost(), contact("Assistance phone"), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "vehicle.toll", category: "vehicle", label: "Toll account", storedKind: "item", parents: ["vehicle.vehicle"],
    use: "A toll account or e-TAG.",
    fields: [provider("Toll provider"), reference("Account number"), notes()],
    identity: ["provider", "reference"],
  },

  // Home
  {
    id: "home.property", category: "home", label: "Home", asset: true, storedKind: "item",
    use: "A place you live in or own. Its lease or mortgage, insurance, rates and utilities belong to it.",
    fields: [name("Name, for example Home"), f("address", "Address"), f("ownership", "Own or rent", "text", { choices: ["own", "rent", "investment"] }), notes()],
    identity: ["address"],
  },
  {
    id: "home.lease", category: "home", label: "Lease", storedKind: "item", parents: ["home.property"],
    use: "A rental lease: rent, when it ends, the agent and the bond.",
    due: { means: "ends", label: "Lease ends" }, reminders: [90, 30],
    fields: [provider("Agent or landlord"), contact(), ...cost("Rent"), f("starts_on", "Started", "date"), f("bond", "Bond", "amount"), reference("Bond number"), notes()],
    identity: ["parent"],
  },
  {
    id: "home.mortgage", category: "home", label: "Mortgage", storedKind: "item", parents: ["home.property"],
    use: "A home loan: the lender, rate and when a fixed rate ends.",
    due: { means: "ends", label: "Fixed rate ends" }, reminders: [60, 14],
    fields: [provider("Lender"), last4("Loan account (last 4)"), f("rate", "Interest rate"), f("rate_type", "Rate type", "text", { choices: ["variable", "fixed", "split"] }), ...cost("Repayment"), notes()],
    identity: ["provider", "last4"],
  },
  {
    id: "home.insurance", category: "home", label: "Home insurance", storedKind: "item", parents: ["home.property"],
    use: "Building, contents, landlord or renters insurance.",
    due: { means: "renews", label: "Renews" }, reminders: [30, 7],
    fields: [provider("Insurer"), reference("Policy number"), f("cover", "Cover", "text", { choices: ["building", "contents", "building and contents", "landlord", "renters"] }), f("sum_insured", "Sum insured", "amount"), f("excess", "Excess", "amount"), ...cost("Premium"), f("claims_phone", "Claims phone", "phone"), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "home.rates", category: "home", label: "Rates or levies", storedKind: "item", parents: ["home.property"],
    use: "Council rates, strata levies, water rates or land tax.",
    due: { means: "due", label: "Next instalment" }, reminders: [14, 3],
    fields: [f("rates_kind", "What", "text", { choices: ["council rates", "strata levies", "water rates", "land tax"] }), provider("Council or strata manager"), reference("Assessment or lot number"), ...cost("Amount"), notes()],
    identity: ["provider", "reference"],
  },

  // Utilities
  {
    id: "utility.energy", category: "utility", label: "Electricity or gas", storedKind: "item", parents: ["home.property"],
    use: "An electricity or gas account.",
    due: { means: "ends", label: "Plan or discount ends" }, reminders: [30],
    fields: [f("service", "Service", "text", { choices: ["electricity", "gas"] }), provider("Retailer"), reference("Account number"), f("plan", "Plan"), f("meter_id", "NMI or MIRN"), ...cost("Typical bill"), contact(), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "utility.water", category: "utility", label: "Water", storedKind: "item", parents: ["home.property"],
    use: "A water account.",
    fields: [provider("Provider"), reference("Account number"), ...cost("Typical bill"), contact(), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "utility.internet", category: "utility", label: "Internet", storedKind: "item", parents: ["home.property"],
    use: "An NBN or other internet plan.",
    due: { means: "ends", label: "Contract ends" }, reminders: [30],
    fields: [provider("Provider"), reference("Account number"), f("plan", "Plan"), ...cost(), contact(), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "utility.phone", category: "utility", label: "Phone", storedKind: "item",
    use: "A mobile or home phone plan.",
    due: { means: "ends", label: "Contract ends" }, reminders: [30],
    fields: [provider("Provider"), reference("Account number"), f("plan", "Plan"), f("phone_number", "Phone number", "phone"), ...cost(), notes()],
    identity: ["provider", "reference"],
  },

  // Other insurance
  {
    id: "insurance.life", category: "insurance", label: "Life or income protection", storedKind: "item",
    use: "Life, TPD, trauma or income protection cover, including cover held inside super.",
    due: { means: "renews", label: "Anniversary" }, reminders: [30],
    fields: [provider("Insurer"), reference("Policy number"), f("covers", "What it covers"), f("benefit", "Benefit"), ...cost("Premium"), f("held_in_super", "Held inside super", "text", { choices: ["yes", "no"] }), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "insurance.travel", category: "insurance", label: "Travel insurance", storedKind: "item",
    use: "A travel insurance policy for a trip or a year.",
    due: { means: "ends", label: "Cover ends" }, reminders: [7],
    fields: [provider("Insurer"), reference("Policy number"), f("starts_on", "Cover starts", "date"), f("region", "Where"), f("emergency_phone", "Emergency phone", "phone"), f("excess", "Excess", "amount"), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "insurance.other", category: "insurance", label: "Other insurance", storedKind: "item",
    use: "Any other insurance policy.",
    due: { means: "renews", label: "Renews" }, reminders: [30, 7],
    fields: [provider("Insurer"), reference("Policy number"), f("covers", "What it covers"), ...cost("Premium"), notes()],
    identity: ["provider", "reference"],
  },

  // Health
  {
    id: "health.insurance", category: "health", label: "Health insurance", storedKind: "item",
    use: "Private health cover: the fund, hospital and extras cover, and who is covered.",
    due: { means: "renews", label: "Renews or extras reset" }, reminders: [45],
    fields: [provider("Fund"), reference("Membership number"), f("hospital_cover", "Hospital cover", "text", { hint: "For example Silver Plus.", choices: ["gold", "silver plus", "silver", "bronze plus", "bronze", "basic", "none"] }), f("extras_cover", "Extras cover"), f("excess", "Excess", "amount"), f("scale", "Who is covered", "text", { choices: ["single", "couple", "family", "single parent"] }), ...cost("Premium"), f("ambulance", "Ambulance cover"), contact(), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "health.ambulance", category: "health", label: "Ambulance cover", storedKind: "item",
    use: "Ambulance cover bought separately from health insurance.",
    due: { means: "renews", label: "Renews" },
    fields: [provider("Provider"), reference("Membership number"), ...cost(), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "health.provider", category: "health", label: "Doctor or provider", storedKind: "item",
    use: "A GP, dentist, specialist or other provider the person sees, and when the next visit is due. Never diagnoses, medicines or results.",
    due: { means: "due", label: "Next visit" }, reminders: [14],
    fields: [f("provider_kind", "Kind", "text", { choices: ["GP", "dentist", "specialist", "physio", "optometrist", "psychologist", "pharmacy"] }), name("Name"), provider("Practice"), contact(), website(), notes()],
    identity: ["provider", "name"],
  },

  // Money & super
  {
    id: "money.super", category: "money", label: "Super fund", storedKind: "item",
    use: "A superannuation fund: the fund, member number and USI a new employer asks for.",
    fields: [provider("Fund"), reference("Member number"), f("product", "Product", "text", { hint: "For example MySuper, Choice or Pension." }), f("usi", "USI"), f("fund_abn", "Fund ABN"), f("employer", "Employer paying into it"), f("insurance_in_super", "Insurance inside super"), contact(), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "money.bank_account", category: "money", label: "Bank account", storedKind: "item",
    use: "A bank or savings account: the bank and the last 4 digits only. Never the BSB and full account number.",
    due: { means: "ends", label: "Rate or term ends" },
    fields: [provider("Bank"), f("account_kind", "Kind", "text", { choices: ["everyday", "savings", "offset", "term deposit"] }), last4("Account (last 4)"), f("rate", "Interest rate"), notes()],
    identity: ["provider", "last4"],
  },
  {
    id: "money.credit_card", category: "money", label: "Credit card", storedKind: "item",
    use: "A credit card's issuer, last 4 digits and annual fee date. Never the card number; cards for purchases live in the Vault.",
    due: { means: "due", label: "Annual fee" }, reminders: [30],
    fields: [provider("Issuer"), f("card_product", "Card"), last4("Card (last 4)"), f("annual_fee", "Annual fee", "amount"), f("promo_ends", "Interest-free or balance transfer ends", "date"), notes()],
    identity: ["provider", "last4"],
  },
  {
    id: "money.loan", category: "money", label: "Loan", storedKind: "item",
    use: "A car, personal or student loan, novated lease or buy-now-pay-later plan.",
    due: { means: "ends", label: "Ends or fixed rate ends" }, reminders: [60],
    fields: [f("loan_kind", "Kind", "text", { choices: ["car", "personal", "novated lease", "buy now pay later", "HECS-HELP"] }), provider("Lender"), last4("Account (last 4)"), f("rate", "Interest rate"), ...cost("Repayment"), notes()],
    identity: ["provider", "last4"],
  },
  {
    id: "money.tax", category: "money", label: "Tax", storedKind: "item",
    use: "A tax return, BAS or instalment due date. Never a tax file number.",
    due: { means: "due", label: "Due" }, reminders: [30, 7],
    fields: [f("tax_kind", "What", "text", { choices: ["tax return", "BAS", "PAYG instalment"] }), f("period", "Period", "text", { hint: "For example FY2026." }), provider("Tax agent"), contact(), notes()],
    identity: ["tax_kind", "period"],
  },

  // ID documents: expiry dates only. The numbers belong in the Vault.
  {
    id: "id.passport", category: "id", label: "Passport", storedKind: "item",
    use: "When a passport expires. Never the passport number: the person keeps it in their Vault.",
    due: { means: "expires", label: "Expires" }, reminders: [270, 180],
    fields: [f("country", "Country"), f("issued_on", "Issued", "date"), notes()],
    identity: ["country"],
  },
  {
    id: "id.driver_licence", category: "id", label: "Driver or rider licence", storedKind: "item",
    use: "When a driver, rider or boat licence expires, and its class. Never the licence or card number.",
    due: { means: "expires", label: "Expires" }, reminders: [60, 14],
    fields: [f("state", "State", "text", { choices: STATES }), f("licence_class", "Class", "text", { hint: "For example C, R or a boat licence." }), f("conditions", "Conditions"), notes()],
    identity: ["state"],
  },
  {
    id: "id.medicare", category: "id", label: "Medicare card", storedKind: "item",
    use: "When the Medicare card expires and who is on it. Never the card number.",
    due: { means: "expires", label: "Valid to" }, reminders: [30],
    fields: [f("people", "People on the card"), notes()],
    identity: [], singleton: true,
  },
  {
    id: "id.visa", category: "id", label: "Visa", storedKind: "item",
    use: "A visa or travel authorisation and when it expires. Never the grant number.",
    due: { means: "expires", label: "Expires or enter by" }, reminders: [90, 30],
    fields: [f("country", "Country"), f("visa_type", "Visa type or subclass"), f("conditions", "Conditions"), notes()],
    identity: ["country", "visa_type"],
  },
  {
    id: "id.check", category: "id", label: "Working with children or police check", storedKind: "item",
    use: "A working with children check, police check or NDIS screening and when it expires.",
    due: { means: "expires", label: "Expires" }, reminders: [90],
    fields: [f("check_kind", "Kind", "text", { choices: ["working with children", "police check", "NDIS screening"] }), f("state", "State", "text", { choices: STATES }), reference("Check number"), notes()],
    identity: ["check_kind", "state"],
  },

  // Work & study
  {
    id: "work.job", category: "work", label: "Job", storedKind: "item",
    use: "An employer, role and payroll contact.",
    due: { means: "ends", label: "Contract ends" },
    fields: [provider("Employer"), f("role", "Role"), f("starts_on", "Started", "date"), contact("Payroll or HR contact"), notes()],
    identity: ["provider"],
  },
  {
    id: "work.licence", category: "work", label: "Licence or registration", storedKind: "item",
    use: "A professional registration, trade licence or certificate (AHPRA, RSA, white card, first aid) and when it expires.",
    due: { means: "expires", label: "Expires" }, reminders: [60, 14],
    fields: [f("licence_kind", "What"), provider("Issuing body"), reference("Registration number"), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "work.study", category: "work", label: "Study", storedKind: "item",
    use: "A course: the institution, student number and census date.",
    due: { means: "due", label: "Census date" }, reminders: [14, 3],
    fields: [provider("Institution"), f("course", "Course"), reference("Student number"), notes()],
    identity: ["provider", "course"],
  },

  // Subscriptions
  {
    id: "subscription.service", category: "subscription", label: "Subscription", storedKind: "subscription",
    use: "Streaming, software, a box or anything else billed on repeat.",
    due: { means: "renews", label: "Renews" },
    fields: [name("Name"), provider("Service"), f("plan", "Plan"), ...cost(), f("trial_ends", "Free trial ends", "date"), f("paid_with", "Paid with", "text", { hint: "For example Visa ending 1234." }), f("how_to_cancel", "How to cancel"), notes()],
    identity: ["title"],
  },
  {
    id: "subscription.membership", category: "subscription", label: "Membership", storedKind: "subscription",
    use: "A gym, club, frequent flyer or professional membership.",
    due: { means: "renews", label: "Renews" }, reminders: [30],
    fields: [provider("Organisation"), reference("Member number"), f("tier", "Level"), ...cost(), f("how_to_cancel", "How to cancel"), notes()],
    identity: ["provider", "reference"],
  },

  // Pets
  {
    id: "pet.pet", category: "pet", label: "Pet", asset: true, storedKind: "item",
    use: "A pet. Its insurance, vaccinations and registration belong to it.",
    fields: [name("Name"), f("species", "Species"), f("breed", "Breed"), f("born_on", "Born", "date"), f("microchip", "Microchip number"), provider("Vet clinic"), contact("Vet phone"), notes()],
    identity: ["name"],
  },
  {
    id: "pet.insurance", category: "pet", label: "Pet insurance", storedKind: "item", parents: ["pet.pet"],
    use: "A pet insurance policy.",
    due: { means: "renews", label: "Renews" }, reminders: [30],
    fields: [provider("Insurer"), reference("Policy number"), f("cover", "Cover"), ...cost("Premium"), notes()],
    identity: ["provider", "reference"],
  },
  {
    id: "pet.care", category: "pet", label: "Vaccination or treatment", storedKind: "item", parents: ["pet.pet"],
    use: "A vaccination, heartworm, flea or worm treatment and when it is next due.",
    due: { means: "due", label: "Next due" }, reminders: [14],
    fields: [f("care_kind", "What"), f("last_done", "Last done", "date"), provider("Clinic"), notes()],
    identity: ["parent", "care_kind"],
  },
  {
    id: "pet.registration", category: "pet", label: "Council registration", storedKind: "item", parents: ["pet.pet"],
    use: "A pet's council registration.",
    due: { means: "renews", label: "Renews" }, reminders: [30],
    fields: [provider("Council"), reference("Registration number"), notes()],
    identity: ["parent"],
  },

  // Receipts & warranties (the original receipt_warranty kind)
  {
    id: "purchase.receipt", category: "purchase", label: "Receipt or warranty", storedKind: "receipt_warranty",
    use: "Something bought: when it can be returned and when its warranty ends.",
    due: { means: "return_by", label: "Return by" }, reminders: [7],
    fields: [f("item", "Item"), provider("Merchant"), f("order_number", "Order number", "reference"), f("purchased_on", "Bought", "date"), f("amount", "Price", "amount"), f("currency", "Currency", "currency"), f("warranty_ends", "Warranty ends", "date"), f("serial_number", "Serial number"), notes()],
    identity: ["provider", "order_number"],
  },

  // Other (the original renewal_appointment kind, and anything without a type)
  {
    id: "general.reminder", category: "general", label: "Renewal or appointment", storedKind: "renewal_appointment",
    use: "A renewal or appointment that fits no other type.",
    due: { means: "due", label: "Due" },
    fields: [name("What"), f("where", "Where"), notes()],
    identity: [],
  },
  {
    id: "general.other", category: "general", label: "Something else", storedKind: "item",
    use: "Anything else worth keeping track of.",
    due: { means: "due", label: "Due" },
    fields: [name("What"), provider("Organisation"), reference("Reference"), contact(), notes()],
    identity: [],
  },
];

const BY_ID: ReadonlyMap<string, RecordTypeDef> = new Map(RECORD_TYPES.map((type) => [type.id, type]));
export const RECORD_TYPE_IDS: readonly string[] = RECORD_TYPES.map((type) => type.id);

export function recordType(id: string): RecordTypeDef | undefined {
  return BY_ID.get(id);
}

export function categoryOf(id: CategoryId): CategoryDef {
  return CATEGORIES.find((category) => category.id === id)!;
}

export function typesInCategory(id: CategoryId): RecordTypeDef[] {
  return RECORD_TYPES.filter((type) => type.category === id);
}

// The typed records whose provider keeps the person's postal address, so a move adds them to
// the moving checklist (brief "Moving-house helper"): rego, licence, insurers, utilities, banks,
// super, Medicare, employers … but not a vehicle or pet itself, a receipt or a one-off date.
const NO_ADDRESS = new Set([
  "vehicle.vehicle", "vehicle.service", "home.property", "home.lease", "pet.pet", "pet.care",
  "purchase.receipt", "general.reminder", "general.other", "id.passport", "id.visa", "insurance.travel", "money.tax",
]);
export function holdsAddress(type: RecordTypeDef): boolean {
  return !NO_ADDRESS.has(type.id);
}

// The type a record saved under one of the three original kinds (before types existed) reads as.
export const LEGACY_KIND_TYPES: Readonly<Record<Exclude<StoredKind, "item">, string>> = {
  subscription: "subscription.service",
  receipt_warranty: "purchase.receipt",
  renewal_appointment: "general.reminder",
};

// The type of a stored record: its own (from the encrypted meta), else the one its original
// kind reads as, else "Something else".
export function typeOfRecord(kind: StoredKind, storedType: string | null | undefined): RecordTypeDef {
  const own = storedType ? recordType(storedType) : undefined;
  if (own) return own;
  return recordType(kind === "item" ? "general.other" : LEGACY_KIND_TYPES[kind])!;
}

// A field's label for a type: the type's own wording ("Insurer"), else null (the caller tidies
// an agent's own key).
export function typeFieldLabel(type: RecordTypeDef, key: string): string | null {
  return type.fields.find((field) => field.key === key)?.label ?? null;
}
