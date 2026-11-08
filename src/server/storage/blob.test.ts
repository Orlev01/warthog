// E14-S02 — the blob storage seam (`src/server/storage/blob.ts`).
//
// RED-first: the module does not exist yet, so importing it throws and every test
// here fails until the implementation lands. These tests pin BEHAVIOUR (what
// put/get/delete do with bytes, that the dev/test store is one per process, and
// that the real store's container/account flow from config) — never the source
// text of the module.
//
// Receipt files live in a PRIVATE blob container (design §2: "Storage account
// (blob), private container, no public access"; files are encrypted by the app
// BEFORE upload). This seam lets the whole app run — under `next dev` and the test
// suite — without Azure: an in-memory fake stands in for the container, held as a
// per-process singleton so a file put by one request is visible to the next. The
// real Azure container/account are read from CONFIGURATION, never hard-coded.
//
// The contract these tests define:
//
//   interface BlobStore {
//     put(key: string, bytes: Uint8Array): Promise<void>;
//     get(key: string): Promise<Uint8Array | null>;  // null = absent (never an opaque throw)
//     delete(key: string): Promise<void>;             // idempotent (missing key is a no-op)
//   }
//
//   createInMemoryBlobStore(): BlobStore
//     • a FRESH, empty in-memory store (for isolated tests). Stores bytes BY VALUE,
//       like a real blob backend (the caller's buffer is copied in and out).
//
//   inMemoryBlobStore: BlobStore
//     • the PROCESS-WIDE singleton the dev/test path uses — one per process, not
//       rebuilt per request, so writes survive across requests/module graphs.
//
//   selectBlobStore({ nodeEnv, account?, container?, openContainer? }): BlobStore
//     • any non-"production" nodeEnv -> the in-memory singleton (needs NO account,
//       container or Azure client — dev/test runs without Azure or any secret).
//     • "production" -> the Azure-backed store: it calls
//       openContainer(account, container) (the account + container the composition
//       root read from config) and delegates to that ContainerClient. It REQUIRES
//       account, container and openContainer — there is no baked-in literal
//       fallback — so a missing one is refused, never defaulted.
//
//   interface BlobContainerClient { getBlockBlobClient(key): BlockBlobClient }
//   interface BlockBlobClient {
//     uploadData(bytes): Promise<unknown>;
//     downloadToBuffer(): Promise<Uint8Array>;   // throws a 404-shaped error when absent
//     exists(): Promise<boolean>;
//     deleteIfExists(): Promise<unknown>;
//   }
//     • the SUBSET of @azure/storage-blob's ContainerClient / BlockBlobClient the
//       real store uses, so tests fake it offline and the composition root can wrap
//       a real ContainerClient directly. Tests never touch Azure or the network.
//
// Scope note on the shared obligations carried by this task:
//   [obligation:validate-and-parameterize-input] — the blob seam runs NO SQL and
//     has NO HTTP handler, so its share of this obligation is that a key is an
//     OPAQUE identifier: it is matched exactly (bound), never concatenated or
//     interpreted, so a key shaped like a SQL-injection probe round-trips as plain
//     data and cannot alter anything (tested below). The "a handler rejects
//     malformed/oversized input with a 4xx" half belongs to the receipt-upload
//     ROUTE task (an HTTP handler over this seam), where request bodies actually
//     arrive — it is characterized there, not forced onto this storage seam.
//   [obligation:secrets-from-env] — no account name, container name, connection
//     string or key is a literal in blob.ts: the in-memory path needs no config at
//     all, and the production path REQUIRES its account + container (which the
//     config module reads from env) and refuses to run without them (tested below).
//
// Every call is awaited so the tests pass whether the implementation is sync or
// async (an in-memory map is naturally sync; the Azure client is Promise-based).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  createInMemoryBlobStore,
  inMemoryBlobStore,
  selectBlobStore,
} from "./blob";
import { openAzureContainer } from "./azure-container";
// Documentary type anchors — the names/shapes the implementation exports. Erased
// at runtime, so a rename that preserves behaviour cannot redden the run for the
// wrong reason; the runtime assertions below are what gate behaviour.
import type { BlobStore, BlobContainerClient, BlockBlobClient } from "./blob";
import { loadConfig } from "../config";

// A distinctive receipt key + random bytes per test, so suites sharing the
// process-wide singleton (node:test runs files in parallel) never collide.
function freshKey(): string {
  return `receipts/${randomUUID()}.pdf`;
}
function freshBytes(n = 64): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

// ---------------------------------------------------------------------------
// A faithful offline stand-in for @azure/storage-blob's ContainerClient: one
// in-memory map of blob name -> bytes, reached through the per-blob client shape
// the real store uses. Models real Azure behaviour where it matters: download of
// a missing blob throws a 404-shaped RestError, and bytes are stored by value.
// ---------------------------------------------------------------------------
function fakeContainer(): BlobContainerClient & { readonly blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    getBlockBlobClient(key: string): BlockBlobClient {
      return {
        async uploadData(bytes: Uint8Array): Promise<unknown> {
          blobs.set(key, Uint8Array.from(bytes)); // copy in, like a real upload
          return {};
        },
        async downloadToBuffer(): Promise<Uint8Array> {
          const stored = blobs.get(key);
          if (stored === undefined) {
            // @azure/storage-blob surfaces a missing blob as a 404 RestError.
            throw Object.assign(new Error("BlobNotFound"), {
              statusCode: 404,
              code: "BlobNotFound",
            });
          }
          return Uint8Array.from(stored); // copy out
        },
        async exists(): Promise<boolean> {
          return blobs.has(key);
        },
        async deleteIfExists(): Promise<unknown> {
          const existed = blobs.delete(key);
          return { succeeded: existed };
        },
      };
    },
  };
}

// ===========================================================================
// AC: put(key, bytes) then get(key) round-trips the EXACT bytes; delete removes
// them; get on a MISSING key reports absence (null) rather than throwing.
// Exercised on a fresh in-memory store so each case is isolated.
// ===========================================================================

test("createInMemoryBlobStore() returns a fresh, empty BlobStore with put/get/delete", async () => {
  assert.equal(typeof createInMemoryBlobStore, "function", "createInMemoryBlobStore is a factory");

  const store: BlobStore = createInMemoryBlobStore();
  assert.equal(typeof store.put, "function", "exposes put");
  assert.equal(typeof store.get, "function", "exposes get");
  assert.equal(typeof store.delete, "function", "exposes delete");

  // Nothing has been written, so an arbitrary key is absent (reported, not thrown).
  await assert.doesNotReject(() => store.get(freshKey()), "get on an empty store does not throw");
  assert.equal(await store.get(freshKey()), null, "an unwritten key is reported absent as null");
});

test("put then get round-trips the exact bytes", async () => {
  const store = createInMemoryBlobStore();
  const key = freshKey();
  const bytes = freshBytes(128);

  await store.put(key, bytes);
  const back = await store.get(key);

  assert.ok(back instanceof Uint8Array, "get returns raw bytes");
  assert.equal(back.length, bytes.length, "the recovered blob is the same length");
  assert.deepEqual([...back], [...bytes], "the recovered bytes equal the stored bytes, exactly");
});

test("get on a missing key reports absence (null) rather than throwing opaquely", async () => {
  const store = createInMemoryBlobStore();

  const missing = freshKey();
  await assert.doesNotReject(() => store.get(missing), "a missing key must not throw");
  assert.equal(await store.get(missing), null, "a missing key resolves to null");
});

test("delete removes a blob; a subsequent get reports absence", async () => {
  const store = createInMemoryBlobStore();
  const key = freshKey();

  await store.put(key, freshBytes());
  assert.notEqual(await store.get(key), null, "the blob exists after put");

  await store.delete(key);
  assert.equal(await store.get(key), null, "the blob is gone after delete");
});

test("delete on a missing key is an idempotent no-op (does not throw)", async () => {
  const store = createInMemoryBlobStore();
  await assert.doesNotReject(() => store.delete(freshKey()), "deleting an absent key is a no-op");
});

test("put overwrites: a second put to the same key replaces the bytes", async () => {
  const store = createInMemoryBlobStore();
  const key = freshKey();
  const first = freshBytes();
  const second = freshBytes();

  await store.put(key, first);
  await store.put(key, second);

  assert.deepEqual([...(await store.get(key))!], [...second], "get returns the latest bytes");
});

// ---------------------------------------------------------------------------
// The in-memory fake behaves like a real blob backend: it stores bytes BY VALUE,
// so mutating the caller's buffer after a put, or mutating a returned buffer, can
// never corrupt the stored blob. (A real container serialises the bytes; an
// aliasing fake would hide round-trip bugs.)
// ---------------------------------------------------------------------------

test("the stored blob is a copy: mutating the caller's buffer after put does not change it", async () => {
  const store = createInMemoryBlobStore();
  const key = freshKey();
  const bytes = Uint8Array.from([10, 20, 30, 40]);

  await store.put(key, bytes);
  bytes[0] = 99; // the caller scribbles on its own buffer after handing it over

  assert.deepEqual([...(await store.get(key))!], [10, 20, 30, 40], "the stored blob is unaffected");
});

test("a returned blob is a copy: mutating it does not change the stored blob", async () => {
  const store = createInMemoryBlobStore();
  const key = freshKey();

  await store.put(key, Uint8Array.from([1, 2, 3, 4]));
  const back = await store.get(key);
  back![0] = 77; // scribble on the returned buffer

  assert.deepEqual([...(await store.get(key))!], [1, 2, 3, 4], "a re-read returns the original bytes");
});

// ===========================================================================
// AC (share of [obligation:validate-and-parameterize-input]): a key is an OPAQUE
// identifier. It is matched EXACTLY — never concatenated into or interpreted as a
// query — so a key shaped like a SQL-injection probe round-trips as plain data,
// and a key that is a prefix of another never collides with it.
// ===========================================================================

test("a SQL-injection-shaped key round-trips as plain data and never collides with other keys", async () => {
  const store = createInMemoryBlobStore();

  const injection = `receipts/'; DROP TABLE blobs; --/${randomUUID()}.pdf`;
  const prefix = "receipts/"; // a prefix of the injection key — must stay a distinct blob
  const payload = freshBytes();
  const other = freshBytes();

  await store.put(injection, payload);
  await store.put(prefix, other);

  // The odd key is stored and retrieved verbatim: it was bound as an exact key,
  // not spliced into anything.
  assert.deepEqual([...(await store.get(injection))!], [...payload], "the probe key round-trips exactly");
  // The prefix is a separate blob — keys are matched exactly, not by containment.
  assert.deepEqual([...(await store.get(prefix))!], [...other], "a prefix key is a distinct blob");

  // Deleting the odd key leaves the prefix blob untouched.
  await store.delete(injection);
  assert.equal(await store.get(injection), null, "the probe key is gone after delete");
  assert.deepEqual([...(await store.get(prefix))!], [...other], "deleting one key does not affect another");
});

test("keys with slashes, spaces and unicode round-trip verbatim", async () => {
  const store = createInMemoryBlobStore();
  const weird = `receipts/2026/recibo — año nuevo/${randomUUID()} (1).pdf`;
  const bytes = freshBytes();

  await store.put(weird, bytes);
  assert.deepEqual([...(await store.get(weird))!], [...bytes], "an awkward key is stored as-is");
});

// ===========================================================================
// AC: the dev/test in-memory blob store is a SINGLE per-process instance (not
// re-created per call), so bytes written by one call are visible to the next.
// Mirrors the outbox / release-store singleton contract.
// ===========================================================================

test("the module exports a single process-wide inMemoryBlobStore instance, not a factory", () => {
  // A ready-to-use store object with the three methods — not a function you call
  // to get a fresh (empty) instance per request.
  assert.equal(typeof inMemoryBlobStore, "object", "inMemoryBlobStore is an instance, not a function");
  assert.notEqual(inMemoryBlobStore, null);
  assert.equal(typeof inMemoryBlobStore.put, "function");
  assert.equal(typeof inMemoryBlobStore.get, "function");
  assert.equal(typeof inMemoryBlobStore.delete, "function");
});

test("the singleton keeps one shared state across re-imports (one per process)", async () => {
  const key = freshKey();
  const bytes = freshBytes();
  await inMemoryBlobStore.put(key, bytes);

  // Re-importing must yield the SAME object (held on globalThis, so it survives the
  // route/page module-graph split Next creates): a blob put through one reference
  // is visible through another.
  const again = await import("./blob");
  assert.equal(again.inMemoryBlobStore, inMemoryBlobStore, "re-import returns the same singleton");
  assert.deepEqual([...(await again.inMemoryBlobStore.get(key))!], [...bytes], "the put is visible via the re-import");
});

test("a freshly created store is independent of the process-wide singleton", async () => {
  const seedKey = freshKey();
  await inMemoryBlobStore.put(seedKey, freshBytes());

  const fresh = createInMemoryBlobStore();
  assert.equal(await fresh.get(seedKey), null, "a fresh store does not see the singleton's blobs");

  const isolatedKey = freshKey();
  await fresh.put(isolatedKey, freshBytes());
  assert.equal(
    await inMemoryBlobStore.get(isolatedKey),
    null,
    "a blob put in a separate instance never appears in the singleton",
  );
});

// ===========================================================================
// AC: selection is driven by nodeEnv. dev/test -> the in-memory singleton (no
// account/container/Azure client needed); production -> the Azure-backed store,
// whose container + account come from config.
// ===========================================================================

test("selectBlobStore in development selects the in-memory store (round-trips with NO account/container/client)", async () => {
  const store: BlobStore = selectBlobStore({ nodeEnv: "development" });
  const key = freshKey();
  const bytes = freshBytes();

  await store.put(key, bytes);
  assert.deepEqual([...(await store.get(key))!], [...bytes], "the dev store round-trips with no Azure config");
});

test("selectBlobStore in the test env selects the in-memory store", async () => {
  const store = selectBlobStore({ nodeEnv: "test" });
  const key = freshKey();
  const bytes = freshBytes();
  await store.put(key, bytes);
  assert.deepEqual([...(await store.get(key))!], [...bytes]);
});

test("selectBlobStore in dev shares ONE process-wide store: a blob put via one selection is visible via another (and via inMemoryBlobStore)", async () => {
  const key = freshKey();
  const bytes = freshBytes();

  const a = selectBlobStore({ nodeEnv: "development" });
  await a.put(key, bytes);

  // A second, independently-obtained dev store must see the write — otherwise a
  // receipt uploaded in one request would vanish before the next reads it.
  const b = selectBlobStore({ nodeEnv: "development" });
  assert.deepEqual([...(await b.get(key))!], [...bytes], "a second dev selection sees the same blob");

  // ...and it is the one process-wide singleton.
  assert.deepEqual([...(await inMemoryBlobStore.get(key))!], [...bytes], "the dev store IS the process-wide singleton");
});

test("selection is driven by nodeEnv: a non-production env uses the in-memory store even if an Azure client is also supplied", async () => {
  const container = fakeContainer();
  let opened = 0;
  const store = selectBlobStore({
    nodeEnv: "development",
    account: "ignored",
    container: "ignored",
    openContainer: () => {
      opened += 1;
      return container;
    },
  });

  const key = freshKey();
  await store.put(key, freshBytes());

  assert.equal(opened, 0, "dev must use the in-memory store, not the stray Azure client");
  assert.equal(container.blobs.size, 0, "nothing was written through the Azure client in dev");
});

// --- production: the Azure-backed store, driven by the config container/account ---

test("selectBlobStore in production uses the Azure client, keyed by the config-supplied account and container", async () => {
  const container = fakeContainer();
  const opened: Array<{ account: string; container: string }> = [];
  const store = selectBlobStore({
    nodeEnv: "production",
    account: "warthogreceipts", // distinctive sentinels prove the values flow from config,
    container: "receipts", // never a literal baked into blob.ts
    openContainer: (account, containerName) => {
      opened.push({ account, container: containerName });
      return container;
    },
  });

  const key = freshKey();
  const bytes = freshBytes();
  await store.put(key, bytes);

  assert.ok(opened.length >= 1, "the production store opened the configured container");
  for (const call of opened) {
    assert.equal(call.account, "warthogreceipts", "the storage ACCOUNT came from config, not a literal");
    assert.equal(call.container, "receipts", "the blob CONTAINER came from config, not a literal");
  }
  // The bytes really went through the Azure client, not the in-memory store.
  assert.deepEqual([...container.blobs.get(key)!], [...bytes], "the blob was written through the Azure container");
});

test("selectBlobStore in production round-trips and deletes through the Azure client, reporting a missing blob as null", async () => {
  const container = fakeContainer();
  const store = selectBlobStore({
    nodeEnv: "production",
    account: "warthogreceipts",
    container: "receipts",
    openContainer: () => container,
  });

  const key = freshKey();
  const bytes = freshBytes();

  // A missing blob is reported absent, not thrown (even though the Azure client
  // throws a 404 for a missing download).
  await assert.doesNotReject(() => store.get(key), "a missing blob does not throw");
  assert.equal(await store.get(key), null, "a missing blob is reported as null");

  await store.put(key, bytes);
  assert.deepEqual([...(await store.get(key))!], [...bytes], "put/get round-trips through Azure");

  await store.delete(key);
  assert.equal(await store.get(key), null, "delete removes the blob");
});

// --- production refuses to run without its config values (no baked-in literal) ---

test("selectBlobStore in production refuses a missing container (no literal fallback)", async () => {
  await assert.rejects(async () => {
    const store = selectBlobStore({
      nodeEnv: "production",
      account: "warthogreceipts",
      openContainer: () => fakeContainer(),
    });
    await store.put(freshKey(), freshBytes());
  }, "production without a configured container must be refused, never defaulted to a literal");
});

test("selectBlobStore in production refuses a missing account (no literal fallback)", async () => {
  await assert.rejects(async () => {
    const store = selectBlobStore({
      nodeEnv: "production",
      container: "receipts",
      openContainer: () => fakeContainer(),
    });
    await store.put(freshKey(), freshBytes());
  }, "production without a configured account must be refused, never defaulted to a literal");
});

// Review fix F7: this used to pin that production REQUIRES an injected client — but no caller
// ever injected one, so the production store could never be built and every life-admin page
// threw. Production now constructs without one, opening the real Azure container lazily.
test("selectBlobStore in production constructs without an injected client (the real Azure opener is the default)", () => {
  assert.doesNotThrow(() =>
    selectBlobStore({ nodeEnv: "production", account: "warthogreceipts", container: "receipts" }),
  );
});

test("selectBlobStore in production never throws at construction: an incomplete config fails loudly on use", async () => {
  let opened = 0;
  const store = selectBlobStore({ nodeEnv: "production", openContainer: () => (opened++, fakeContainer()) });
  await assert.rejects(store.put(freshKey(), freshBytes()), /STORAGE_ACCOUNT/);
  await assert.rejects(store.get(freshKey()), /STORAGE_ACCOUNT/);
  const noContainer = selectBlobStore({ nodeEnv: "production", account: "warthogreceipts", openContainer: () => (opened++, fakeContainer()) });
  await assert.rejects(noContainer.delete(freshKey()), /STORAGE_CONTAINER/);
  assert.equal(opened, 0, "no container is opened for an incomplete config");
});

test("selectBlobStore in production opens the container once, on first use", async () => {
  let opened = 0;
  const container = fakeContainer();
  const store = selectBlobStore({
    nodeEnv: "production",
    account: "warthogreceipts",
    container: "receipts",
    openContainer: async () => {
      opened++;
      return container;
    },
  });
  assert.equal(opened, 0, "nothing is opened at construction");
  const key = freshKey();
  await store.put(key, freshBytes());
  await store.get(key);
  await store.delete(key);
  assert.equal(opened, 1, "the container is opened once and reused");
});

test("selectBlobStore in production refuses a malformed account or container name", async () => {
  for (const [account, container] of [
    ["evil.example.com/x", "receipts"],
    ["WarthogReceipts", "receipts"],
    ["warthogreceipts", "../other"],
  ] as const) {
    const store = selectBlobStore({ nodeEnv: "production", account, container, openContainer: () => fakeContainer() });
    await assert.rejects(store.put(freshKey(), freshBytes()), /STORAGE_/);
  }
});

test("openAzureContainer builds a real Azure ContainerClient for the configured account and container, offline", async () => {
  const container = (await openAzureContainer("warthogreceipts", "receipts")) as unknown as { url: string };
  assert.equal(container.url, "https://warthogreceipts.blob.core.windows.net/receipts");
  assert.equal(typeof (container as unknown as BlobContainerClient).getBlockBlobClient, "function");
});

// ===========================================================================
// AC: the blob container and account are read from CONFIGURATION (via the config
// module), never a literal in source; config is read from env ([secrets-from-env]).
// loadConfig surfaces them from env; they are optional (undefined when unset),
// mirroring the keyVault / acs config groups.
// ===========================================================================

// A minimal, fully-valid DEVELOPMENT env (loadConfig throws on a missing required
// var). Secrets are generated in-test so the base64 is always well-formed.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");
function devEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "http://localhost:3000",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
    ...extra,
  };
}

test("loadConfig surfaces the blob storage account and container from the environment", () => {
  const cfg = loadConfig(
    devEnv({ STORAGE_ACCOUNT: "warthogreceipts", STORAGE_CONTAINER: "receipts" }),
  );
  assert.equal(cfg.blob.account, "warthogreceipts", "the storage account is read from STORAGE_ACCOUNT");
  assert.equal(cfg.blob.container, "receipts", "the blob container is read from STORAGE_CONTAINER");
});

test("the blob storage config is read from env, not a hard-coded literal (distinct values flow through)", () => {
  const a = loadConfig(devEnv({ STORAGE_ACCOUNT: "acct-one", STORAGE_CONTAINER: "cont-one" }));
  const b = loadConfig(devEnv({ STORAGE_ACCOUNT: "acct-two", STORAGE_CONTAINER: "cont-two" }));
  assert.equal(a.blob.account, "acct-one");
  assert.equal(a.blob.container, "cont-one");
  assert.equal(b.blob.account, "acct-two");
  assert.equal(b.blob.container, "cont-two");
});

test("the blob storage config is absent (undefined) when its env vars are unset", () => {
  const cfg = loadConfig(devEnv({}));
  assert.equal(cfg.blob.account, undefined, "no STORAGE_ACCOUNT -> undefined, not a literal default");
  assert.equal(cfg.blob.container, undefined, "no STORAGE_CONTAINER -> undefined, not a literal default");
});
