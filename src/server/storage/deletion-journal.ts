import { createDeletionJournal, type JournalWriter } from "../account/deletion-journal";
import { processSingleton } from "../seams/process-singleton";

interface Container {
  getBlockBlobClient(name: string): {
    uploadData(bytes: Uint8Array, options: { conditions: { ifNoneMatch: string }; blobHTTPHeaders: { blobContentType: string } }): Promise<unknown>;
  };
}

export function azureJournalWriter(container: () => Promise<Container>): JournalWriter {
  return {
    async create(name, body) {
      try {
        await (await container()).getBlockBlobClient(name).uploadData(Buffer.from(body), {
          conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" },
        });
      } catch (error) {
        const failure = error as { statusCode?: number; code?: string };
        // Only our create-if-absent precondition is an idempotent success.
        // A firewall, authentication, retention-policy or network error is not.
        if (failure?.statusCode === 412 && failure.code === "ConditionNotMet") return;
        throw new Error("Deletion journal write failed");
      }
    },
  };
}

export function selectDeletionJournal(options: {
  nodeEnv: string; account?: string; container?: string;
}): ReturnType<typeof createDeletionJournal> {
  if (options.nodeEnv !== "production") {
    return processSingleton("account.deletion-journal.dev", () => {
      const records = new Map<string, string>();
      return createDeletionJournal({ async create(name, body) { if (!records.has(name)) records.set(name, body); } });
    });
  }
  let client: Promise<Container> | undefined;
  return createDeletionJournal(azureJournalWriter(async () => {
    if (!/^[a-z0-9]{3,24}$/.test(options.account ?? "")
        || !/^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/.test(options.container ?? "")) {
      throw new Error("Deletion journal storage configuration is required");
    }
    client ??= (async () => {
      const [{ ContainerClient }, { DefaultAzureCredential }] = await Promise.all([
        import("@azure/storage-blob"), import("@azure/identity"),
      ]);
      return new ContainerClient(`https://${options.account}.blob.core.windows.net/${options.container}`,
        new DefaultAzureCredential(), { retryOptions: { maxTries: 2, tryTimeoutInMs: 5_000 } });
    })();
    client.catch(() => { client = undefined; });
    return client;
  }));
}
