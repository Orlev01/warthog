import { test } from "node:test";
import assert from "node:assert/strict";
import { assertProductionDatabaseConfiguration, type Config } from "../config";

const url = (user: string, host = "database.example.test", mode = "verify-full") => `postgresql://${user}:private-test-password@${host}/warthog?sslmode=${mode}`;
const config = { nodeEnv: "production", databaseUrl: url("runtime"), migrationDatabaseUrl: url("migrate"), purgeDatabaseUrl: url("purge") } as Config;

test("production database roles require distinct logins, one database and certificate verification without leaking values", () => {
  assert.doesNotThrow(() => assertProductionDatabaseConfiguration(config));
  for (const bad of [
    { ...config, migrationDatabaseUrl: undefined },
    { ...config, purgeDatabaseUrl: config.databaseUrl },
    { ...config, migrationDatabaseUrl: url("migrate", "wrong.example.test") },
    { ...config, databaseUrl: url("runtime", "database.example.test", "require") },
    { ...config, databaseUrl: `${url("runtime")}&user=migrate` },
    { ...config, databaseUrl: `${url("runtime")}&host=wrong.example.test` },
    { ...config, databaseUrl: `${url("runtime")}&sslmode=no-verify` },
  ]) assert.throws(() => assertProductionDatabaseConfiguration(bad), (error: Error) => !error.message.includes("private-test-password") && !error.message.includes("wrong.example.test"));
});
