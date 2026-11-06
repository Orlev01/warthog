// The blob storage seam. Receipt files live in a PRIVATE blob container (design §2:
// "Storage account (blob), private container, no public access"; files are encrypted
// by the app BEFORE upload). This module keeps the encrypting receipt-file store pure
// by varying only the data source: an in-memory fake under `next dev` and the test
// suite (so the whole app runs without Azure or any secret), and a real Azure
// ContainerClient in production, whose account + container flow from configuration —
// never a literal baked in here (INV-103: secrets-from-env).
//
// A key is an OPAQUE identifier: it is matched EXACTLY (bound as a map key / blob
// name), never concatenated into or interpreted as a query, so a key shaped like a
// SQL-injection probe round-trips as plain data (INV-102's share for a seam that runs
// no SQL and has no HTTP handler).

import { processSingleton } from "../seams/process-singleton";

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
  readonly openContainer?: (account: string, container: string) => BlobContainerClient;
}

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

// The Azure-backed store: every operation delegates to the real ContainerClient,
// keyed by the (opaque) blob key. A missing blob is reported as null.
function azureBlobStore(container: BlobContainerClient): BlobStore {
  return {
    async put(key, bytes) {
      await container.getBlockBlobClient(key).uploadData(bytes);
    },
    async get(key) {
      try {
        const buffer = await container.getBlockBlobClient(key).downloadToBuffer();
        return Uint8Array.from(buffer);
      } catch (err) {
        if (isBlobNotFound(err)) return null;
        throw err;
      }
    },
    async delete(key) {
      await container.getBlockBlobClient(key).deleteIfExists();
    },
  };
}

// Choose the blob store by environment. Any non-"production" nodeEnv uses the
// in-memory singleton (no account, container or Azure client — dev/test runs without
// Azure or any secret). "production" uses the Azure-backed store, which REQUIRES the
// account, container (both read from config by the composition root) and an
// openContainer client: a missing one is refused, never defaulted to a literal.
export function selectBlobStore(options: SelectBlobStoreOptions): BlobStore {
  if (options.nodeEnv !== "production") {
    return inMemoryBlobStore;
  }
  const { account, container, openContainer } = options;
  if (account === undefined || account === "") {
    throw new Error("Blob storage account is required in production (config STORAGE_ACCOUNT)");
  }
  if (container === undefined || container === "") {
    throw new Error("Blob storage container is required in production (config STORAGE_CONTAINER)");
  }
  if (openContainer === undefined) {
    throw new Error("Blob storage requires an openContainer client in production");
  }
  return azureBlobStore(openContainer(account, container));
}
