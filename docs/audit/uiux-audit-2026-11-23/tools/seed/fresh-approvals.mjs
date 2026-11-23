// Set the typical account's approval expiry to 24h, then raise fresh pending approvals so Inbox
// and Home screens show live requests for the whole review (local dev only).
import { readFileSync } from "node:fs";
import { open, clickWithStepUp, BASE } from "./browser.mjs";
import { call } from "./mcp.mjs";

const acct = process.argv[2] ?? "typical";
const { browser, page } = await open(acct);
await page.goto(`${BASE}/rules`);
const field = page.locator('[name="approval-expiry-minutes"]');
await field.selectOption("1440");
await clickWithStepUp(page, page.getByRole("button", { name: "Save approval expiry" }));
await page.goto(`${BASE}/rules`);
console.log("expiry now:", await page.locator('[name="approval-expiry-minutes"]').inputValue());
await browser.close();

const s = JSON.parse(readFileSync(new URL(`./state/${acct}.json`, import.meta.url), "utf8"));
const [claude, , gemini] = s.agents.map((a) => a.token);
for (const [t, tool, args] of [
  [claude, "request_card", { amount: 240, currency: "AUD", merchant: "Mazda Parramatta", reason: "Balance for the 48,000 km logbook service" }],
  [claude, "request_identity_detail", { field: "driver_licence", purpose: "Fill in the Service NSW registration renewal form", reason: "Renewing your rego" }],
  [gemini, "request_identity_detail", { field: "passport", purpose: "Add passport details to the Qantas booking for international check-in", reason: "Airline needs it before check-in opens" }],
  [gemini, "request_card", { amount: 180, currency: "NZD", merchant: "Coronet Peak Snow School", reason: "Two half-day ski lessons for Mia and Leo" }],
]) { const r = await call(t, tool, args); console.log(r.ok ? "·" : "✗", tool, r.ok ? "" : r.text.slice(0, 120)); }
