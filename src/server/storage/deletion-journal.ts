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
      let blob: ReturnType<Container["getBlockBlobClient"]>;
      try {
        blob = (await container()).getBlockBlobClient(name);
      } catch {
        throw new Error("Deletion journal write failed");
      }
      try {
        await blob.uploadData(Buffer.from(body), {
          conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" },
        });
      } catch (error) {
        const failure = error as { statusCode?: number; code?: string };
        // Azure's add-only role checks overwrite permission before If-None-Match
        // on an existing blob. Both exact responses acknowledge its existence,
        // not that these retry bytes were stored: the first timestamp must win.
        // Generic authorization, firewall, retention or network errors still fail.
        if (failure?.statusCode === 412 && failure.code === "ConditionNotMet"
            || failure?.statusCode === 403 && failure.code === "UnauthorizedBlobOverwrite") return;
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
