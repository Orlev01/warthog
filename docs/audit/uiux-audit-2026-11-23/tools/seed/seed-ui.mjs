// Seed step 3 (local dev only): member-side data only the UI creates.
import { open, clickWithStepUp, BASE } from "./browser.mjs";
const acct = process.argv[2];
const { browser, page } = await open(acct);
const step = (m) => console.log(`· ${m}`);
const tryStep = async (name, fn) => { try { await fn(); step(name); } catch (e) { console.log(`✗ ${name}: ${e.message.split("\n")[0]}`); await page.screenshot({ path: `state/${acct}-ui-fail-${name.replace(/\W+/g, "_")}.png`, fullPage: true }); } };

await tryStep("rule: ask first for card requests", async () => {
  await page.goto(`${BASE}/rules?view=new`);
  await page.getByRole("radio", { name: /Request a card/ }).check();
  await page.waitForTimeout(500);
  await clickWithStepUp(page, page.getByRole("button", { name: "Add rule" }));
});
await tryStep("rule: never allow messages for Gemini", async () => {
  await page.goto(`${BASE}/rules?view=new`);
  await page.getByRole("radio", { name: /Never allow/ }).check();
  await page.getByRole("radio", { name: /^Gemini/ }).check();
  await page.waitForTimeout(500);
  await clickWithStepUp(page, page.getByRole("button", { name: "Add rule" }));
});
await tryStep("household", async () => {
  await page.goto(`${BASE}/household`);
  await clickWithStepUp(page, page.getByRole("button", { name: "Create a household" }));
  await page.goto(`${BASE}/household`);
  const email = page.getByLabel(/email/i).first();
  if (await email.isVisible().catch(() => false)) {
    await email.fill("sam.nguyen@warthog.test");
    await clickWithStepUp(page, page.getByRole("button", { name: /Invite|Send invite/ }).first());
  }
});
await browser.close();
