// Read-only operator tool, never an app route. Requires separately approved
// read/list access from the private network; the app's add-only grant cannot run it.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { captureDeletionJournal } from "../src/server/account/deletion-journal";

async function main() {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3 || process.env.WARTHOG_RECOVERY_WRITERS_STOPPED !== "1") {
    throw new Error("Supply an owner-only output path and independently verify stopped writers before capture");
  }
  const container = new ContainerClient(
    "https://stwarthogprodauee854.blob.core.windows.net/account-deletions",
    new DefaultAzureCredential(), { retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 } },
  );
  const snapshot = await captureDeletionJournal({
    async read(name) {
      // Bound network buffering before parsing. A malformed large object must not
      // allocate an unbounded buffer; the parser rejects anything above 1024 bytes.
      return (await container.getBlockBlobClient(name).downloadToBuffer(0, 1025)).toString("utf8");
    },
    async *list(prefix) {
      for await (const item of container.listBlobsFlat({ prefix })) yield item.name;
    },
  });
  await writeFile(resolve(output), JSON.stringify(snapshot) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Captured ${snapshot.records.length} deletion events. This does not authorize restoration or reopening traffic.`);
}

main().catch(() => {
  console.error("Deletion journal capture failed; keep recovery closed. Inspect privately without exposing account IDs or credentials.");
  process.exitCode = 1;
});
