// Seed step 1 (local dev only): sign up a synthetic member with a virtual passkey, connect agents
// over real OAuth (DCR + consent), and save the signed-in storage state plus each agent's token.
// usage: node signup-agents.mjs <accountKey> <name> <agentNames,comma,separated>
import { createHash, randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const BASE = process.env.BASE ?? "http://localhost:3241";
const OUT = new URL(".", import.meta.url).pathname + "state/";
const [key = "typical", fullName = "Alexandra Nguyen", agentList = ""] = process.argv.slice(2);
const agentNames = agentList ? agentList.split("|") : [];
const email = `${key}-${Date.now()}@warthog.test`;
const CALLBACK = "http://localhost:9999/callback";
const T = { timeout: 120000 };
const b64url = (b) => Buffer.from(b).toString("base64url");
const step = (m) => console.log(`· ${m}`);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(90000);
  const page = await ctx.newPage();
  globalThis.__page = page;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  await page.goto(`${BASE}/signup`);
  await page.getByLabel("Your name").fill(fullName);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor(T);
  const box = await ctx.newPage();
  await box.goto(`${BASE}/dev/outbox`);
  const text = await box.locator("body").innerText();
  const code = text.slice(text.lastIndexOf(email)).match(/\b(\d{6})\b/)[1];
  await box.close();
  await page.getByLabel("Your code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create a passkey" }).click(T);
  await page.getByLabel("I've saved it").check(T);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`${BASE}/home`, T);
  step(`signed up ${email}`);

  const agents = [];
  for (const agentName of agentNames) {
    const reg = await fetch(`${BASE}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: agentName.split(" — ")[0], redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    const client = await reg.json();
    if (!client.client_id) throw new Error(`DCR failed ${JSON.stringify(client)}`);
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const resource = `${BASE}/mcp`;
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource });
    let callbackUrl = null;
    await page.route(`${CALLBACK}**`, async (route) => { callbackUrl = route.request().url(); await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }); });
    await page.goto(`${BASE}/oauth/authorize?${q}`);
    await page.getByRole("button", { name: /Approve connection/ }).waitFor(T);
    await page.getByLabel("Agent name").fill(agentName);
    if (process.env.TEMPLATE) await page.getByLabel(new RegExp(process.env.TEMPLATE)).check().catch(() => {});
    await page.getByRole("button", { name: /Approve connection/ }).click();
    const confirm = page.getByRole("button", { name: /Confirm it.s you/ });
    for (let i = 0; i < 40 && !callbackUrl; i++) {
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); break; }
      await page.waitForTimeout(250);
    }
    for (let i = 0; i < 120 && !callbackUrl; i++) await page.waitForTimeout(500);
    await page.unroute(`${CALLBACK}**`);
    if (!callbackUrl) throw new Error(`consent never reached callback for ${agentName}`);
    const authCode = new URL(callbackUrl).searchParams.get("code");
    const tok = await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource }) });
    const tokens = await tok.json();
    if (!tokens.access_token) throw new Error(`token failed ${JSON.stringify(tokens)}`);
    agents.push({ name: agentName, token: tokens.access_token });
    step(`connected agent "${agentName}"`);
  }
  await page.goto(`${BASE}/home`);
  await ctx.storageState({ path: `${OUT}${key}-storage.json` });
  // Keep the passkey so later steps (step-up) can sign it again in a fresh context.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  await writeFile(`${OUT}${key}.json`, JSON.stringify({ email, fullName, agents, credentials }, null, 2));
  step(`saved ${OUT}${key}.json`);
} catch (e) {
  console.log(`✗ ${e.message.split("\n")[0]}`);
  await globalThis.__page?.screenshot({ path: `${OUT}${key}-fail.png` }).catch(() => {});
  console.log(await globalThis.__page?.url());
  process.exitCode = 1;
} finally {
  await browser.close();
}
