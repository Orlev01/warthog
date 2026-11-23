const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: `state/${process.argv[2]}-storage.json` });
const page = await ctx.newPage();
await page.goto("http://localhost:3241/agents");
const out = {};
for (const a of await page.locator('a[href^="/agents/"]').all()) { const h = await a.getAttribute("href"); const m = h.match(/\/agents\/([0-9a-f-]{36})/); if (m) out[(await a.innerText()).trim()] ??= m[1]; }
console.log(JSON.stringify(out));
await browser.close();
