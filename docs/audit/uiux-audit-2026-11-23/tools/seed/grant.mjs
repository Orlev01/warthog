// Turn on protected-detail requests and card access for the named agents (local dev only).
// usage: node grant.mjs <acct> <agentId> [agentId…]
import { open, clickWithStepUp, BASE } from "./browser.mjs";

const [acct, ...ids] = process.argv.slice(2);
const { browser, page } = await open(acct);
try {
  for (const id of ids) {
    for (const [section, label] of [["vault", /Let it ask for protected details/], ["spending", /Let it ask to use a card/]]) {
      await page.goto(`${BASE}/agents/${id}?section=${section}`);
      const box = page.getByRole("checkbox", { name: label });
      if (!(await box.isChecked())) await box.check();
      if (section === "spending") await page.getByLabel("Card budget per month (AUD)").fill("300");
      await clickWithStepUp(page, page.getByRole("button", { name: "Save changes" }).first());
      await page.goto(`${BASE}/agents/${id}?section=${section}`);
      console.log(`· ${id.slice(0, 8)} ${section}: ${await page.getByRole("checkbox", { name: label }).isChecked()}`);
    }
  }
} finally {
  await browser.close();
}
