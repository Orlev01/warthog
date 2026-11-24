// A category an agent suggests (`./custom-category.ts`): its generic shape is validated
// deterministically, injection-shaped labels and field names are refused, a built-in under
// another name is redirected, and anchor links are checked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { builtInFor, definitionOf, newCategorySchema, sameLabel, slugFrom, SLUG_PATTERN } from "./custom-category";

const rowing = {
  label: "Rowing club",
  description: "Membership, regattas and the club's boats.",
  lifeArea: "everyday",
  icon: "trophy",
  why: "12 emails from the rowing club: fees, regattas and boat bookings.",
  kinds: [
    { key: "shell", label: "Boat", lifecycle: "standing", use: "A racing boat the person rows.", anchor: true, fields: [{ key: "hull", label: "Hull name", kind: "text" }], identity: ["hull"] },
    { key: "regatta", label: "Regatta", lifecycle: "booking", use: "A regatta entry.", belongsTo: ["self.shell"], fields: [{ key: "event_number", label: "Event", kind: "text" }] },
    { key: "fees", label: "Club fees", lifecycle: "standing", use: "Annual club fees.", due: { means: "renews", label: "Fees due" }, fields: [] },
  ],
};

const hull = rowing.kinds[0]!.fields[0]!;
const parse = (draft: unknown) => newCategorySchema.safeParse(draft);
const messages = (result: ReturnType<typeof parse>) => (result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));

test("a good suggestion passes and becomes a stored definition", () => {
  const result = parse(rowing);
  assert.equal(result.success, true, messages(result).join("\n"));
  const definition = definitionOf(result.data!);
  assert.equal(definition.icon, "trophy");
  assert.equal(definition.kinds[0]!.anchor, true);
  assert.deepEqual(definition.kinds[1]!.belongsTo, ["self.shell"]);
});

test("labels and words are plain: no links, addresses, long numbers or markup", () => {
  for (const label of ["See https://evil.example", "Ring 0298765432", "<b>Club</b>", "x", "Mail me@x.com"]) {
    assert.equal(parse({ ...rowing, label }).success, false, label);
  }
  assert.equal(parse({ ...rowing, why: "Pay at www.evil.example now" }).success, false);
  assert.equal(parse({ ...rowing, kinds: [{ ...rowing.kinds[0], use: "Code 123456 for access" }] }).success, false);
});

test("field names Warthog never keeps, its own names and health details are refused", () => {
  for (const field of [
    { key: "verification_code", label: "Code", kind: "text" },
    { key: "account_pin", label: "PIN", kind: "text" },
    { key: "member", label: "Tax file number", kind: "text" },
    { key: "status", label: "Status", kind: "text" },
    { key: "diagnosis", label: "Diagnosis", kind: "text" },
    { key: "medication", label: "Medicine", kind: "text" },
  ]) {
    const result = parse({ ...rowing, kinds: [{ ...rowing.kinds[0], fields: [hull, field] }] });
    assert.equal(result.success, false, field.key);
    assert.ok(messages(result).every((message) => !message.includes(field.label) || message.includes(`"${field.key}"`)), "a refusal never echoes the value");
  }
  assert.equal(parse({ ...rowing, kinds: [{ ...rowing.kinds[0], fields: [hull, { key: "amount", label: "Fee", kind: "text" }] }] }).success, false, "a common field keeps its kind");
  assert.equal(parse({ ...rowing, kinds: [{ ...rowing.kinds[0], fields: [hull, { key: "amount", label: "Fee", kind: "amount" }] }] }).success, true, "relabelling a common field is fine");
});

test("a built-in under another name is redirected to its kind", () => {
  assert.equal(builtInFor("Flights"), "travel.flight");
  assert.equal(builtInFor("Gym membership"), "subscriptions.membership");
  assert.equal(builtInFor("Boats"), "vehicles.vehicle");
  assert.equal(builtInFor("Rowing club"), null);
  const result = parse({ ...rowing, label: "Flights" });
  assert.equal(result.success, false);
  assert.match(messages(result).join(" "), /travel\.flight/);
});

test("anchor links: an anchor never belongs, targets must be anchors, at most 2 anchors", () => {
  assert.equal(parse({ ...rowing, kinds: [{ ...rowing.kinds[0], belongsTo: ["any"] }] }).success, false);
  assert.equal(parse({ ...rowing, kinds: [rowing.kinds[0], { ...rowing.kinds[1], belongsTo: ["self.fees"] }] }).success, false, "fees isn't an anchor");
  assert.equal(parse({ ...rowing, kinds: [rowing.kinds[0], { ...rowing.kinds[1], belongsTo: ["vehicles.registration"] }] }).success, false);
  assert.equal(parse({ ...rowing, kinds: [rowing.kinds[0], { ...rowing.kinds[1], belongsTo: ["vehicles.vehicle"] }] }).success, true);
  assert.equal(parse({ ...rowing, kinds: [rowing.kinds[0], { ...rowing.kinds[1], belongsTo: ["any"] }] }).success, true);
  const anchors = ["a", "b", "c"].map((key) => ({ key: `${key}_thing`, label: `Thing ${key}`, lifecycle: "standing", use: "A thing.", anchor: true, fields: [] }));
  assert.equal(parse({ ...rowing, kinds: anchors }).success, false);
  assert.equal(parse({ ...rowing, kinds: [{ ...rowing.kinds[0], identity: ["nope"] }] }).success, false, "identity names a field");
});

test("ids are random, never words; similar labels are recognised", () => {
  const slug = slugFrom(new Uint8Array([0, 1, 2, 3, 4, 250]));
  assert.match(slug, SLUG_PATTERN);
  assert.ok(!/[aeiou]/.test(slug.slice(2)));
  assert.equal(sameLabel("Rowing club", "Rowing Clubs"), true);
  assert.equal(sameLabel("Rowing club", "Chess club"), false);
});

// Building a profile (docs/adr/profile-build.md): an agent reading everything can't turn sensitive
// parts of someone's life into a category.
test("a category about health, religion, politics, a union, sexuality or criminal matters is refused", () => {
  for (const [label, why] of [
    ["IVF clinic", "Emails from the clinic about cycles"],
    ["Church", "Weekly emails from the parish about giving"],
    ["Mosque donations", "Receipts from the mosque"],
    ["Political party", "Membership renewals from the party"],
    ["Trade union", "Union dues and meeting notices"],
    ["LGBTQ group", "Newsletters and events"],
    ["Parole", "Letters about reporting dates"],
  ]) {
    const result = parse({ ...rowing, label, why });
    assert.equal(result.success, false, label);
    assert.ok(messages(result).some((message) => message.includes("Warthog doesn't keep a category about")), label);
    assert.ok(messages(result).every((message) => !message.includes(label)), "a refusal never echoes the label");
  }
  assert.equal(parse({ ...rowing, why: "Sensitive: emails from my church choir about rowing" }).success, false, "the reason counts too");
  for (const label of ["Credit union", "Tennis court bookings", "Birthday parties", "Rowing club"]) {
    assert.equal(parse({ ...rowing, label, why: "12 emails about it" }).success, true, label);
  }
});
