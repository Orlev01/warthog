import { readFileSync } from "node:fs";
import { call } from "./mcp.mjs";
const s = JSON.parse(readFileSync("state/typical.json", "utf8"));
const [claude, chatgpt, gemini] = s.agents.map((a) => a.token);
const G = s.agents[2].name;
for (const [t, title, assignee] of [
  [claude, "Renew the car registration before it lapses", "b64192db-d48f-434c-a212-3c2ab02d126b"],
  [claude, "Chase AAMI about the windscreen claim", "b64192db-d48f-434c-a212-3c2ab02d126b"],
  [gemini, "Book ski lessons for Mia and Leo in Queenstown", "a2b5fea2-c5e4-4ef3-98c3-6d2ed22c6edf"],
  [chatgpt, "Cancel Paramount+ before the trial ends", "bc90026d-bbf1-4b98-a5b2-07a612c991a7"],
  [chatgpt, "Pay the Waverley Council parking fine", "any"],
  [gemini, "Find a dog sitter for Biscuit while we're away", "a2b5fea2-c5e4-4ef3-98c3-6d2ed22c6edf"],
]) { const r = await call(t, "create_task", { title, assignee, reason: "Keeping track" }); console.log(r.ok ? "·" : "✗", title, r.ok ? "" : r.text.slice(0, 120)); }
const l = await call(chatgpt, "list_tasks", {});
const id = l.text.match(/([0-9a-f]{8}-[0-9a-f-]{27})/)?.[1];
if (id) console.log("complete:", (await call(chatgpt, "complete_task", { id, reason: "Done" })).ok);
