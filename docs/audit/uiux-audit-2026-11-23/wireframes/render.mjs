// Render the static wireframes to PNG (operator tool; Playwright is not a Warthog dependency).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const DIR = new URL(".", import.meta.url).pathname;
const pages = [["home-desktop", 1440, 1000], ["agent-access-desktop", 1440, 1180], ["inbox-phone", 900, 940], ["life-admin-more-phone", 900, 940]];
const b = await chromium.launch();
for (const [name, width, height] of pages) {
  const p = await b.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await p.goto(`file://${DIR}${name}.html`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${DIR}${name}.png`, fullPage: true });
  console.log(`${name}.png`);
}
await b.close();
