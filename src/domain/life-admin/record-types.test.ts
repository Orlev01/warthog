// The life-admin record types (`./record-types.ts`): the catalogue is internally consistent,
// so the validation, the skill text and the page built from it can't disagree.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  CATEGORY_IDS,
  LEGACY_KIND_TYPES,
  RECORD_TYPES,
  recordType,
  typeOfRecord,
  typesInCategory,
} from "./record-types";

test("every type id is unique and names its own category", () => {
  const ids = RECORD_TYPES.map((type) => type.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const type of RECORD_TYPES) {
    assert.match(type.id, /^[a-z]+\.[a-z_]+$/);
    assert.equal(type.id.split(".")[0], type.category, type.id);
    assert.ok((CATEGORY_IDS as readonly string[]).includes(type.category), type.id);
  }
});

test("every category is described and has at least one type", () => {
  assert.deepEqual(CATEGORIES.map((category) => category.id), [...CATEGORY_IDS]);
  for (const category of CATEGORIES) {
    assert.ok(category.label && category.description, category.id);
    assert.ok(typesInCategory(category.id).length > 0, category.id);
  }
});

test("field keys are unique per type, and identity names its own fields or the parent", () => {
  for (const type of RECORD_TYPES) {
    const keys = type.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, type.id);
    for (const key of keys) assert.match(key, /^[a-z][a-z0-9_]*$/, `${type.id}.${key}`);
    for (const part of type.identity) {
      if (part === "parent") assert.ok(type.parents?.length, `${type.id} identity uses a parent it can't have`);
      else if (part !== "title") assert.ok(keys.includes(part), `${type.id} identity names ${part}`);
    }
  }
});

test("parents are asset types", () => {
  for (const type of RECORD_TYPES) {
    for (const parent of type.parents ?? []) assert.equal(recordType(parent)?.asset, true, `${type.id} → ${parent}`);
  }
});

test("no type has a field for a government identifier or a secret", () => {
  const forbidden = /passport_?n|licen[cs]e_?n|medicare_?n|tfn|tax_file|password|pin$|cvv|bsb|card_number/;
  for (const type of RECORD_TYPES) {
    for (const field of type.fields) assert.doesNotMatch(field.key, forbidden, `${type.id}.${field.key}`);
  }
});

test("the three original kinds read as types that store as those kinds", () => {
  for (const [kind, id] of Object.entries(LEGACY_KIND_TYPES)) {
    assert.equal(recordType(id)?.storedKind, kind);
    assert.equal(typeOfRecord(kind as "subscription", null).id, id);
  }
  assert.equal(typeOfRecord("item", null).id, "general.other");
  assert.equal(typeOfRecord("item", "vehicle.registration").id, "vehicle.registration");
  assert.equal(typeOfRecord("subscription", "not.a_type").id, "subscription.service");
});

test("only the original kinds' types store as those kinds; the rest store as item", () => {
  for (const type of RECORD_TYPES) {
    if (type.storedKind !== "item") assert.ok(["subscription", "purchase", "general"].includes(type.category), type.id);
  }
  assert.equal(recordType("health.insurance")?.storedKind, "item");
  assert.equal(recordType("id.passport")?.storedKind, "item");
});
