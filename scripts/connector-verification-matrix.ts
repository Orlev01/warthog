// Read-only report of checked-in evidence. This performs no provider requests.
import { readdir, readFile } from "node:fs/promises";
import { connectorVerification } from "../src/domain/catalogue/verification";

const entries = await Promise.all((await readdir("catalogue/connectors")).filter(file => file.endsWith(".json")).sort().map(async file => {
  const entry = JSON.parse(await readFile(`catalogue/connectors/${file}`, "utf8"));
  const evidence = connectorVerification(entry.id);
  return {
    id: entry.id, name: entry.name, connectionKind: entry.auth_kind,
    configurationSource: `catalogue/connectors/${file}`,
    localEvidence: evidence.local,
    localAcceptanceSource: evidence.local === "protocol_tested" ? `src/server/connectors/curated/${entry.id.startsWith("google-") ? "google" : "microsoft"}.test.ts` : null,
    liveEvidence: evidence.live ?? { testedAt: null, operations: [], connect: "unverified", identity: "unverified", read: "unverified", writeApproval: "unverified", error: "unverified", refresh: "unverified", reconnect: "unverified", revoke: "unverified" },
  };
}));
console.log(JSON.stringify({ asOf: "2026-11-12", scope: "Configured, simulated protocol acceptance and observed live operation sets are distinct. Unverified is not failed or passed. No live calls were made by this report.", entries }, null, 2));
