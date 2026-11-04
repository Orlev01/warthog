// E03-S03 — Activity hash chain (`src/domain/activity/hash-chain.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (what `entryHash` returns, what `verifyChain`
// reports), never the source text of the module, so a later rename that keeps
// behaviour leaves them untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). A SHA-256 over in-memory bytes is pure
// computation, so it belongs here. The integrity check recomputes the chain over
// the stored ciphertext (`payload_ct`) without ever decrypting it (design §9).
//
// Design §9: `entry_hash = SHA-256(prev_hash ‖ canonical(all other fields incl.
// payload_ct))`; `seq` is contiguous per user. The record is append-only and
// tamper-evident: altering, removing or reordering an entry must be detectable
// by recomputing the chain from the stored fields alone.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it):
//
//   // The hashed content of one entry — the activity columns the hash covers
//   // (everything except prev_hash and entry_hash themselves). Modelled loosely
//   // here with representative fields; the real column set is the data layer's.
//   type Fields = Record<string, string | number | ...>;
//
//   // entryHash(prevHash, fields): SHA-256 over prevHash followed by a CANONICAL
//   // encoding of fields. Pure and deterministic. "Canonical" means the encoding
//   // does not depend on the key insertion order of `fields` — the same content
//   // always hashes the same, however the object was built or re-read.
//   function entryHash(prevHash: string, fields: Fields): string;
//
//   // One link of the chain, carrying everything needed to re-verify it.
//   interface ChainEntry { seq: number; prevHash: string; entryHash: string; fields: Fields; }
//
//   // verifyChain(entries): walks the entries IN THE ORDER GIVEN and returns a
//   // DISCRIMINATED UNION on `intact`:
//   //   { intact: true }                      — every entry re-verifies and links.
//   //   { intact: false, brokenSeq: number }  — the seq of the FIRST entry that
//   //                                            fails to verify.
//   // An entry verifies when (a) its stored entryHash recomputes from
//   // (prevHash, fields), and (b) its prevHash equals the previous entry's
//   // entryHash. The FIRST entry's prevHash is the chain ANCHOR: verifyChain
//   // accepts it as given and does NOT compare it to any fixed constant (a bare
//   // hash chain has no external head, so a forged/removed first entry or a
//   // dropped LAST entry is out of scope — altering, reordering, or removing a
//   // NON-boundary entry is fully covered, which is what the AC requires).
//   function verifyChain(entries: readonly ChainEntry[]): { intact: true } | { intact: false; brokenSeq: number };
//
// Why build chains with the module's own `entryHash`? So the two functions are
// consistent BY CONSTRUCTION: these tests never hard-code a digest or assert the
// exact canonical byte layout (that is the builder's free choice), they assert
// the PROPERTIES the AC names — stability, sensitivity to any field change, and
// that verifyChain flags the first altered / removed / reordered entry.

import { test } from "node:test";
import assert from "node:assert/strict";

import { entryHash, verifyChain } from "./hash-chain";

// ---------------------------------------------------------------------------
// Local, structural fixtures. Typed loosely so they stay assignable to whatever
// (reasonable) shape the implementation gives Fields / ChainEntry.
// ---------------------------------------------------------------------------

type Fields = Record<string, string | number>;

interface Entry {
  seq: number;
  prevHash: string;
  entryHash: string;
  fields: Fields;
}

// The anchor prevHash of the first entry. Its VALUE is deliberately arbitrary:
// per the pinned contract, verifyChain treats the first entry's prevHash as the
// anchor and never compares it to a fixed constant — so a valid chain built from
// any genesis verifies as intact. (This single-entry/anchor assumption is what
// the single-entry intact test below also exercises.)
const GENESIS = "genesis";

// Distinct content per position, so each entry hashes differently and any
// reorder/removal genuinely changes the linkage.
function entryFields(n: number): Fields {
  return {
    kind: "tool_call",
    agent_id: `agent-${n}`,
    tool: "gmail__send",
    outcome: "allow",
    amount: 1000 + n,
    currency: "AUD",
    merchant: `merchant-${n}`,
    payload_ct: `v1:ciphertext-${n}`,
  };
}

// Build a valid chain of `count` entries using the module's own entryHash, so a
// correct verifyChain must report it intact.
function buildChain(count: number): Entry[] {
  const entries: Entry[] = [];
  let prevHash = GENESIS;
  for (let seq = 1; seq <= count; seq += 1) {
    const fields = entryFields(seq);
    const hash = entryHash(prevHash, fields);
    entries.push({ seq, prevHash, entryHash: hash, fields });
    prevHash = hash;
  }
  return entries;
}

type VerifyResult = ReturnType<typeof verifyChain>;

function assertIntact(result: VerifyResult, message: string): void {
  assert.equal(result.intact, true, message);
}

// Assert the chain was reported broken and return the reported first-broken seq.
// `assert.fail` returns `never`, so this narrows `result` to the broken member.
function brokenSeqOf(result: VerifyResult): number {
  if (result.intact) {
    assert.fail("expected the chain to be reported BROKEN, but verifyChain reported intact");
  }
  assert.equal(typeof result.brokenSeq, "number", "a broken result carries a numeric brokenSeq");
  return result.brokenSeq;
}

// ===========================================================================
// entryHash — AC1: stable for the same inputs; changes if any field changes.
// ===========================================================================

test("entryHash returns a non-empty string digest", () => {
  const hash = entryHash(GENESIS, entryFields(1));
  assert.equal(typeof hash, "string", "the entry hash is a string");
  assert.ok(hash.length > 0, "the entry hash is non-empty");
});

test("entryHash is stable: identical inputs always produce the identical hash", () => {
  const fields = entryFields(7);
  assert.equal(
    entryHash(GENESIS, fields),
    entryHash(GENESIS, fields),
    "the same prevHash and the same fields hash to the same value every time",
  );
  // A fresh object with the same CONTENT must hash the same — no hidden state,
  // no dependence on object identity.
  assert.equal(
    entryHash(GENESIS, entryFields(7)),
    entryHash(GENESIS, { ...entryFields(7) }),
    "equal content in a different object instance hashes to the same value",
  );
});

test("entryHash is canonical: field key order does not change the hash", () => {
  // A canonical encoding is independent of key insertion order — that is what
  // makes verification robust to a differently-ordered object (e.g. one re-read
  // from the database). Same content, two key orders → one hash.
  const inOrder = entryHash(GENESIS, { kind: "x", tool: "y", amount: 1 });
  const reordered = entryHash(GENESIS, { amount: 1, tool: "y", kind: "x" });
  assert.equal(inOrder, reordered, "reordering the fields' keys must not change the hash");
});

test("entryHash changes when any single field value changes", () => {
  const base = entryFields(3);
  const baseHash = entryHash(GENESIS, base);

  assert.notEqual(
    entryHash(GENESIS, { ...base, outcome: "deny" }),
    baseHash,
    "changing a string field (outcome) changes the hash",
  );
  assert.notEqual(
    entryHash(GENESIS, { ...base, amount: base.amount === 0 ? 1 : 0 }),
    baseHash,
    "changing a numeric field (amount) changes the hash",
  );
  assert.notEqual(
    entryHash(GENESIS, { ...base, payload_ct: "v1:tampered" }),
    baseHash,
    "changing the ciphertext payload changes the hash",
  );
});

test("entryHash changes when the prevHash changes (prev_hash is part of the preimage)", () => {
  const fields = entryFields(4);
  assert.notEqual(
    entryHash("prev-A", fields),
    entryHash("prev-B", fields),
    "the same fields under a different previous hash produce a different entry hash",
  );
});

test("entryHash distinguishes entries with different content", () => {
  assert.notEqual(
    entryHash(GENESIS, entryFields(1)),
    entryHash(GENESIS, entryFields(2)),
    "two entries with different field content hash differently",
  );
});

// ===========================================================================
// verifyChain — AC2: intact for a valid chain; reports the first broken seq
// when any entry is altered, removed or reordered.
// ===========================================================================

test("verifyChain reports intact for a valid multi-entry chain", () => {
  assertIntact(verifyChain(buildChain(4)), "an untouched, correctly-linked chain verifies as intact");
});

test("verifyChain reports intact for a single-entry chain (first entry is the anchor)", () => {
  // The lone entry's prevHash is the chain anchor and must be accepted as given;
  // its own hash recomputes, so the chain is intact.
  assertIntact(verifyChain(buildChain(1)), "a single, self-consistent entry is intact");
});

test("verifyChain reports intact for an empty chain (nothing to break)", () => {
  assertIntact(verifyChain([]), "an empty chain has no broken entry and is intact");
});

test("verifyChain reports the first broken seq when a field is altered (hash not updated)", () => {
  const chain = buildChain(3);
  // Alter the content of the seq-2 entry but leave its stored entryHash in place:
  // the recomputation no longer matches, so the break is reported exactly at 2.
  const tampered = chain.map((e) =>
    e.seq === 2 ? { ...e, fields: { ...e.fields, outcome: "deny" } } : e,
  );

  assert.equal(
    brokenSeqOf(verifyChain(tampered)),
    2,
    "an altered entry whose hash was not recomputed is flagged at its own seq",
  );
});

test("verifyChain stays tamper-evident when the altered entry's own hash is recomputed", () => {
  const chain = buildChain(3);
  // A smarter tamper: change seq-2's content AND recompute seq-2's own entryHash
  // so that entry is internally consistent. The NEXT entry's prevHash still points
  // at the old hash of seq 2, so the break surfaces at seq 3 — the chain is still
  // broken, just one link downstream.
  const tampered = chain.map((e) => {
    if (e.seq !== 2) return e;
    const fields = { ...e.fields, outcome: "deny" };
    return { ...e, fields, entryHash: entryHash(e.prevHash, fields) };
  });

  assert.equal(
    brokenSeqOf(verifyChain(tampered)),
    3,
    "recomputing only the altered entry's hash moves the detected break to the next link",
  );
});

test("verifyChain reports a break when a (non-boundary) entry is removed", () => {
  const chain = buildChain(3);
  // Drop the middle entry (seq 2). The seq-3 entry's prevHash no longer matches
  // the seq-1 entry's hash, so the chain no longer links.
  const removed = chain.filter((e) => e.seq !== 2);

  const result = verifyChain(removed);
  const seq = brokenSeqOf(result);
  assert.ok(
    seq >= 2,
    "the break is reported at or after the removed position, never in the untouched prefix",
  );
});

test("verifyChain reports a break when entries are reordered", () => {
  const chain = buildChain(3);
  // Swap the seq-2 and seq-3 entries. The entry now in the second position does
  // not link to the first, so the chain is broken.
  const reordered = [chain[0], chain[2], chain[1]];

  const result = verifyChain(reordered);
  const seq = brokenSeqOf(result);
  assert.ok(
    seq >= 2,
    "the break is reported at or after the first swapped position, never in the untouched prefix",
  );
});

test("verifyChain reports the FIRST broken seq when several entries are altered", () => {
  const chain = buildChain(4);
  // Alter both seq 2 and seq 3 (hashes left stale). verifyChain must report the
  // earliest break (seq 2) and not a later one.
  const tampered = chain.map((e) =>
    e.seq === 2 || e.seq === 3 ? { ...e, fields: { ...e.fields, outcome: "deny" } } : e,
  );

  assert.equal(
    brokenSeqOf(verifyChain(tampered)),
    2,
    "with multiple broken entries, the first broken seq is reported",
  );
});
