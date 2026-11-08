// The production blob container client (design §2: "Storage account (blob), private container,
// no public access"; the app authenticates with its user-assigned managed identity, which holds
// the blob data contributor role). The account and container come from config (INV-103) and
// have already been validated by `./blob`; this module only builds the client.
//
// The Azure SDK modules are imported here on first use only, so dev/test (the in-memory store)
// never load Azure. Building the client contacts nothing: the first network call is the first
// blob operation.

import type { BlobContainerClient } from "./blob";

export async function openAzureContainer(account: string, container: string): Promise<BlobContainerClient> {
  const [{ ContainerClient }, { DefaultAzureCredential }] = await Promise.all([
    import("@azure/storage-blob"),
    import("@azure/identity"),
  ]);
  return new ContainerClient(
    `https://${account}.blob.core.windows.net/${container}`,
    new DefaultAzureCredential(),
  );
}
