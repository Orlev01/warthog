// The built-in life-admin catalogue (`./record-types.ts`) and the per-person catalogue built from
// it (`./catalogue.ts`): internally consistent, so validation, the skill text and the page built
// from them can't disagree, and relationships are one generic rule for built-in and custom kinds.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUILT_IN_CATEGORIES,
  BUILT_IN_TYPES,
  CATEGORY_ICONS,
  COMMON_FIELD_KEYS,
  LEGACY_KIND_TYPES,
  LIFE_AREAS,
} from "./record-types";
import { BUILT_IN, buildCatalogue, visibilityOf } from "./catalogue";

test("built-in ids are single lower-case words, and every kind names its own category", () => {
  for (const cat of BUILT_IN_CATEGORIES) assert.match(cat.id, /^[a-z]+$/, cat.id);
  const ids = BUILT_IN_TYPES.map((type) => type.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const type of BUILT_IN_TYPES) {
    assert.match(type.id, /^[a-z]+\.[a-z_]+$/);
    assert.equal(type.id.split(".")[0], type.category, type.id);
    assert.ok(BUILT_IN_CATEGORIES.some((cat) => cat.id === type.category), type.id);
    assert.ok(!type.id.startsWith("x_"), "built-in ids never look like a person's own category");
  }
});

test("every category has a life area, an icon from the set, and at least one kind", () => {
  for (const cat of BUILT_IN_CATEGORIES) {
    assert.ok((LIFE_AREAS as readonly string[]).includes(cat.lifeArea), cat.id);
    assert.ok((CATEGORY_ICONS as readonly string[]).includes(cat.icon), cat.id);
    assert.ok(cat.label && cat.description && cat.promptWords, cat.id);
    assert.ok(BUILT_IN.typesIn(cat.id).length > 0, cat.id);
  }
});

test("every kind has the common fields once, and bookings and cases their own", () => {
  for (const type of BUILT_IN_TYPES) {
    const keys = type.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, type.id);
    for (const key of COMMON_FIELD_KEYS) assert.ok(keys.includes(key), `${type.id} has ${key}`);
    if (type.lifecycle === "booking") {
      assert.ok(keys.includes("starts_at") && keys.includes("ends_at"), type.id);
      assert.ok(type.defaultMinutes, type.id);
    }
    if (type.lifecycle === "case") {
      assert.ok(keys.includes("stage") && keys.includes("next_step"), type.id);
    }
  }
  assert.equal(BUILT_IN.type("vehicles.insurance")!.fields.find((field) => field.key === "provider")!.label, "Insurer", "a kind's own label wins");
});

test("identity names the kind's fields, the parent or the title", () => {
  for (const type of BUILT_IN_TYPES) {
    const keys = new Set(type.fields.map((field) => field.key));
    for (const alternative of type.identity) {
      for (const part of alternative) {
        if (part === "parent") assert.ok(type.belongsTo?.length, `${type.id} identity uses a parent it can't have`);
        else if (part !== "title") assert.ok(keys.has(part), `${type.id} identity names ${part}`);
      }
    }
  }
});

test("a receipt, a subscription or a membership can belong to whatever it was for", () => {
  const trip = BUILT_IN.type("travel.trip")!;
  const business = BUILT_IN.type("business.entity")!;
  const valuable = BUILT_IN.type("belongings.valuable")!;
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("belongings.receipt")!, trip), true, "an eSIM bought for a trip");
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("belongings.receipt")!, valuable), true, "the receipt for a valuable");
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("subscriptions.service")!, business), true, "a business's software plan");
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("subscriptions.membership")!, business), true);
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("subscriptions.loyalty")!, trip), false, "a loyalty programme is the person's own");
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("belongings.valuable")!, trip), false, "an anchor still never belongs");
});

test("relationships are one rule: anchors take what may belong to them, and never belong themselves", () => {
  const bike = BUILT_IN.type("vehicles.vehicle")!;
  const trip = BUILT_IN.type("travel.trip")!;
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("vehicles.registration")!, bike), true);
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("vehicles.registration")!, trip), false);
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("travel.flight")!, trip), true, "a booking belongs to any anchor");
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("outings.restaurant")!, bike), true);
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("insurance.other")!, bike), true);
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("pets.pet")!, BUILT_IN.type("home.property")!), false, "an anchor never belongs to an anchor");
  assert.equal(BUILT_IN.canBelongTo(BUILT_IN.type("health.insurance")!, bike), false);
  for (const type of BUILT_IN_TYPES) {
    for (const target of type.belongsTo ?? []) {
      if (target !== "any") assert.equal(BUILT_IN.type(target)?.anchor, true, `${type.id} → ${target}`);
    }
  }
});

test("no kind has a field for a government identifier or a secret, and document kinds are marked", () => {
  const forbidden = /passport_?n|licen[cs]e_?n|medicare_?n|tfn|tax_file|password|pin$|cvv|bsb|card_number/;
  for (const type of BUILT_IN_TYPES) {
    for (const field of type.fields) assert.doesNotMatch(field.key, forbidden, `${type.id}.${field.key}`);
    if (type.documentLike) assert.equal(type.category, "id", type.id);
  }
  assert.ok(BUILT_IN.type("id.passport")!.documentLike);
});

test("the original kinds read as kinds that store as those kinds; a removed kind reads as Something else", () => {
  for (const [kind, id] of Object.entries(LEGACY_KIND_TYPES)) {
    assert.equal(BUILT_IN.type(id)?.storedKind, kind);
    assert.equal(BUILT_IN.typeOfRecord(kind as "subscription", null).id, id);
  }
  assert.equal(BUILT_IN.typeOfRecord("item", "vehicles.registration").id, "vehicles.registration");
  assert.equal(BUILT_IN.typeOfRecord("subscription", "x_bcdfgh.gone").id, "other.item");
  assert.equal(BUILT_IN.isRemovedType("x_bcdfgh.gone"), true);
  assert.equal(BUILT_IN.isRemovedType(null), false);
  for (const type of BUILT_IN_TYPES) {
    if (type.storedKind !== "item") assert.ok(["subscriptions", "belongings", "other"].includes(type.category), type.id);
  }
});

test("a person's own category joins their catalogue, before Other, with generic links", () => {
  const catalogue = buildCatalogue([{
    slug: "x_bcdfgh",
    state: "suggested",
    definition: {
      label: "Rowing club", description: "The rowing club", lifeArea: "everyday", icon: "trophy",
      kinds: [
        { key: "shell", label: "Boat", lifecycle: "standing", use: "A boat.", anchor: true, fields: [{ key: "hull", label: "Hull", kind: "text" }], identity: ["hull"] },
        { key: "regatta", label: "Regatta", lifecycle: "booking", use: "A regatta.", belongsTo: ["self.shell"], fields: [] },
      ],
    },
  }]);
  assert.equal(catalogue.categories.at(-1)!.id, "other");
  assert.equal(catalogue.category("x_bcdfgh")!.origin, "custom");
  const shell = catalogue.type("x_bcdfgh.shell")!;
  const regatta = catalogue.type("x_bcdfgh.regatta")!;
  assert.equal(shell.anchor, true);
  assert.deepEqual(regatta.belongsTo, ["x_bcdfgh.shell"]);
  assert.equal(catalogue.canBelongTo(regatta, shell), true);
  assert.equal(catalogue.canBelongTo(catalogue.type("insurance.other")!, shell), true, "built-in kinds belong to custom anchors too");
  assert.equal(catalogue.canBelongTo(catalogue.type("outings.restaurant")!, shell), true);
  assert.equal(catalogue.customStates.x_bcdfgh, "suggested");
  assert.equal(regatta.storedKind, "item");
});

test("built-in categories stay hidden until used, or shown, or set aside", () => {
  assert.equal(visibilityOf(false, undefined, "builtin"), "available");
  assert.equal(visibilityOf(true, undefined, "builtin"), "shown");
  assert.equal(visibilityOf(false, "show", "builtin"), "shown");
  assert.equal(visibilityOf(true, "not_for_me", "builtin"), "not_for_me");
  assert.equal(visibilityOf(false, undefined, "custom"), "shown");
});

// Founder, 23 Nov 2026: "what is my account name, what is my account number, what email address
// is it associated with … meaningful data should be carried over and stored." An account, policy
// or membership says what identifies it to the person; a thing, an ID document, a booking, a
// matter in progress or a government record has no account fields.
test("accounts, policies and memberships have an account name, their number and the email they're registered to, in that order", () => {
  const accounts = BUILT_IN_TYPES.filter((type) => type.account).map((type) => type.id);
  for (const id of ["investing.super", "utilities.energy", "health.insurance", "vehicles.insurance", "subscriptions.service", "subscriptions.loyalty", "banking.card", "business.domain"]) {
    assert.ok(accounts.includes(id), `${id} is an account`);
  }
  for (const id of ["vehicles.vehicle", "travel.trip", "travel.flight", "id.passport", "other.case", "government.payment", "legal.document", "health.script", "belongings.receipt"]) {
    assert.ok(!accounts.includes(id), `${id} isn't an account`);
  }
  for (const type of BUILT_IN_TYPES) {
    const keys = type.fields.map((field) => field.key);
    if (type.account) {
      assert.ok(type.lifecycle === "standing" && !type.anchor && !type.documentLike, type.id);
      assert.deepEqual(keys.slice(0, 5), ["name", "provider", "account_name", "reference", "account_email"], type.id);
      assert.equal(type.fields.find((field) => field.key === "account_email")!.kind, "email", type.id);
    } else {
      assert.ok(!keys.includes("account_name") && !keys.includes("account_email"), type.id);
    }
  }
  const label = (id: string, key: string) => BUILT_IN.type(id)!.fields.find((field) => field.key === key)!.label;
  assert.equal(label("investing.super", "reference"), "Member number", "a kind's own name for its number");
  assert.equal(label("utilities.energy", "reference"), "Account number");
  assert.equal(label("subscriptions.service", "reference"), "Account number");
  assert.equal(label("banking.account", "reference"), "Reference", "a bank account keeps only its last 4, never an account number");
  assert.equal(label("investing.super", "account_name"), "Account name");
  assert.equal(label("investing.super", "account_email"), "Account email");
});

// Founder, 25 Nov 2026: "a place to see all those recurring bills and the date they are due and
// the accounts they are going to come out of and the emails associated with them". A bill kind
// has Paid with after its cycle, and Next payment only when its own date isn't the payment.
test("bills: which kinds, which date is the payment, and Paid with after the cycle", () => {
  const bills = BUILT_IN_TYPES.filter((type) => type.bill);
  assert.deepEqual(bills.filter((type) => type.bill!.paid === "manual").map((type) => type.id).sort(), [
    "business.registration", "family.activity", "family.school", "home.rates", "pets.registration", "vehicles.registration", "work.licence",
  ]);
  assert.equal(bills.length, 29);
  for (const id of ["government.payment", "investing.pension", "work.job", "government.help", "travel.insurance", "subscriptions.loyalty", "banking.account", "belongings.receipt"]) {
    assert.ok(!BUILT_IN.type(id)!.bill, `${id} isn't a bill`);
  }
  const nextPayment = bills.filter((type) => type.bill!.date === "next_payment").map((type) => type.id).sort();
  assert.deepEqual(nextPayment, ["banking.loan", "home.lease", "home.mortgage", "utilities.energy", "utilities.internet", "utilities.phone", "utilities.water", "vehicles.toll"]);
  for (const type of bills) {
    const keys = type.fields.map((field) => field.key);
    assert.ok(type.account, `${type.id} has the account fields`);
    assert.equal(keys.filter((key) => key === "paid_with").length, 1, type.id);
    assert.equal(keys[keys.indexOf("cycle") + 1], type.bill!.date === "next_payment" ? "next_payment" : "paid_with", type.id);
    assert.equal(keys.includes("next_payment"), type.bill!.date === "next_payment", type.id);
  }
  const paidWith = BUILT_IN.type("subscriptions.service")!.fields.find((field) => field.key === "paid_with")!;
  assert.match(paidWith.hint!, /Visa ending 1234\. Last 4 digits only\./, "a generic example, never someone's card");
  assert.equal(paidWith.suggest, "payment_sources");
  assert.ok(!BUILT_IN.type("investing.super")!.fields.some((field) => field.key === "paid_with"), "not a bill");
});
