// The blob storage seam. Receipt files live in a PRIVATE blob container (design §2:
// "Storage account (blob), private container, no public access"; files are encrypted
// by the app BEFORE upload). This module keeps the encrypting receipt-file store pure
// by varying only the data source: an in-memory fake under `next dev` and the test
// suite (so the whole app runs without Azure or any secret), and a real Azure
// ContainerClient in production, whose account + container flow from configuration —
// never a literal baked in here (INV-103: secrets-from-env).
//
// The production store is built LAZILY: constructing it never throws (every life-admin page
// builds one), and the container is validated and opened on the first blob operation, which
// fails loudly, naming the missing setting, when the configuration is incomplete.
//
// A key is an OPAQUE identifier: it is matched EXACTLY (bound as a map key / blob
// name), never concatenated into or interpreted as a query, so a key shaped like a
// SQL-injection probe round-trips as plain data (INV-102's share for a seam that runs
// no SQL and has no HTTP handler).

import { processSingleton } from "../seams/process-singleton";
import { openAzureContainer } from "./azure-container";

export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>; // null = absent (never an opaque throw)
  delete(key: string): Promise<void>; // idempotent (missing key is a no-op)
}

// The SUBSET of @azure/storage-blob's ContainerClient / BlockBlobClient the real
// store uses. Declaring it here lets the composition root wrap a real ContainerClient
// directly, and lets tests fake it offline — no test ever touches Azure or the network.
export interface BlockBlobClient {
  uploadData(bytes: Uint8Array): Promise<unknown>;
  downloadToBuffer(): Promise<Uint8Array>; // throws a 404-shaped error when absent
  exists(): Promise<boolean>;
  deleteIfExists(): Promise<unknown>;
}

export interface BlobContainerClient {
  getBlockBlobClient(key: string): BlockBlobClient;
}

export interface SelectBlobStoreOptions {
  readonly nodeEnv: string;
  readonly account?: string;
  readonly container?: string;
  // Opens the container (default: the real Azure client authenticated with the app's managed
  // identity, `./azure-container`). Tests inject a fake.
  readonly openContainer?: (
    account: string,
    container: string,
  ) => BlobContainerClient | Promise<BlobContainerClient>;
}

// Azure naming rules: a storage account is 3-24 lowercase letters and digits; a container is
// 3-63 lowercase letters, digits and single hyphens, starting and ending alphanumeric. Checked
// before either reaches a URL.
const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;
const CONTAINER_NAME = /^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/;

// A FRESH, empty in-memory store (for isolated tests). Stores bytes BY VALUE, like a
// real blob backend: the caller's buffer is copied in on put and copied out on get, so
// mutating either side can never corrupt the stored blob.
export function createInMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      blobs.set(key, Uint8Array.from(bytes));
    },
    async get(key) {
      const stored = blobs.get(key);
      return stored === undefined ? null : Uint8Array.from(stored);
    },
    async delete(key) {
      blobs.delete(key);
    },
  };
}

// The PROCESS-WIDE singleton the dev/test path uses — one per process, held on
// globalThis so it survives the route/page module-graph split Next creates, so a
// receipt put by one request is visible to the next.
export const inMemoryBlobStore: BlobStore = processSingleton(
  "storage.blob.in-memory",
  createInMemoryBlobStore,
);

// Does this error look like Azure's 404 for a missing blob? @azure/storage-blob
// surfaces a missing blob as a RestError with statusCode 404 / code "BlobNotFound";
// we report that as absence (null) rather than letting it throw.
function isBlobNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; code?: unknown };
  return e.statusCode === 404 || e.code === "BlobNotFound";
}

// The Azure-backed store: every operation delegates to the real ContainerClient, keyed by the
// (opaque) blob key, opened through `container()` on first use. A missing blob is reported as
// null.
function azureBlobStore(container: () => Promise<BlobContainerClient>): BlobStore {
  return {
    async put(key, bytes) {
      await (await container()).getBlockBlobClient(key).uploadData(bytes);
    },
    async get(key) {
      const client = (await container()).getBlockBlobClient(key);
      try {
        const buffer = await client.downloadToBuffer();
        return Uint8Array.from(buffer);
      } catch (err) {
        if (isBlobNotFound(err)) return null;
        throw err;
      }
    },
    async delete(key) {
      await (await container()).getBlockBlobClient(key).deleteIfExists();
    },
  };
}

// Choose the blob store by environment. Any non-"production" nodeEnv uses the
// in-memory singleton (no account, container or Azure client — dev/test runs without
// Azure or any secret). "production" uses the Azure-backed store, which REQUIRES the
// account and container (both read from config by the composition root): a missing or
// malformed one is refused, never defaulted to a literal — on the first blob operation,
// never at construction, so a page that builds the store without using it always renders.
export function selectBlobStore(options: SelectBlobStoreOptions): BlobStore {
  if (options.nodeEnv !== "production") {
    return inMemoryBlobStore;
  }
  const { account, container } = options;
  const open = options.openContainer ?? openAzureContainer;
  let opened: Promise<BlobContainerClient> | undefined;
  return azureBlobStore(() => {
    if (account === undefined || account === "") {
      return Promise.reject(new Error("Blob storage account is required in production (config STORAGE_ACCOUNT)"));
    }
    if (container === undefined || container === "") {
      return Promise.reject(
        new Error("Blob storage container is required in production (config STORAGE_CONTAINER)"),
      );
    }
    if (!ACCOUNT_NAME.test(account)) {
      return Promise.reject(new Error("Invalid configuration: STORAGE_ACCOUNT is not a storage account name"));
    }
    if (!CONTAINER_NAME.test(container)) {
      return Promise.reject(new Error("Invalid configuration: STORAGE_CONTAINER is not a container name"));
    }
    opened ??= (async () => open(account, container))();
    opened.catch(() => {
      opened = undefined;
    });
    return opened;
  });
}
