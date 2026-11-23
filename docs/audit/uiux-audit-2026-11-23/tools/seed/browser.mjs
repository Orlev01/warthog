// Shared helper: a signed-in browser context for a seeded account, with its passkey restored
// into a virtual authenticator so "Confirm it's you" step-ups pass.
import { readFileSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

export const BASE = process.env.BASE ?? "http://localhost:3241";
const DIR = new URL(".", import.meta.url).pathname;

export async function open(acct, viewport = { width: 1280, height: 900 }) {
  const state = JSON.parse(readFileSync(`${DIR}state/${acct}.json`, "utf8"));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: `${DIR}state/${acct}-storage.json`, viewport });
  ctx.setDefaultTimeout(60000);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  for (const c of state.credentials ?? []) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: c });
  return { browser, ctx, page, state };
}

// Click a button; if a "Confirm it's you" step-up appears, pass it (virtual passkey) and let the
// form resubmit.
export async function clickWithStepUp(page, locator) {
  await locator.click();
  const confirm = page.getByRole("button", { name: /Confirm it.s you/ });
  for (let i = 0; i < 16; i++) {
    if (await confirm.isVisible().catch(() => false)) { await confirm.click(); await page.waitForTimeout(1500); break; }
    await page.waitForTimeout(250);
  }
  await page.waitForLoadState("networkidle").catch(() => {});
}
