// Dump the accessible tree of <main> for a path (debug helper).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = "http://localhost:3241";
const [acct, ...paths] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: `state/${acct}-storage.json`, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
for (const p of paths) {
  await page.goto(BASE + p);
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log(`===== ${p} -> ${page.url()}`);
  console.log((await page.locator("main").ariaSnapshot()).slice(0, Number(process.env.MAX ?? 6000)));
}
await browser.close();
