import { spawn } from "node:child_process";

if (process.platform !== "linux" || process.versions.node.split(".")[0] !== "22" || process.env.WARTHOG_LOCAL_PG_CHECK !== "1") {
  throw new Error("Run this check only through scripts/local-postgres-check.compose.yaml on Node 22 Linux");
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Local check exited with status ${code}`)));
  });
}
try {
  await run("npm", ["run", "typecheck"]);
  await run("npm", ["test"]);
  await run("node", ["--import", "tsx", "scripts/verify-local-postgres.ts"]);
  // The boot smoke test rebuilds Next. Re-stage that final output and validate the
  // migrations/catalogue/static assets rather than retaining the earlier build.
  await run("node", ["scripts/prepare-runtime.mjs"]);
  console.log("Local Linux suite and PostgreSQL checks passed. Final-image production startup, TLS, Azure ingress and live integrations remain separate gates.");
} catch {
  console.error("Local certification failed. Review the preceding test output; no deployment is authorized.");
  process.exitCode = 1;
}
