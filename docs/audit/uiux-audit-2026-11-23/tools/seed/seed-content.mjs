// Seed step 2 (local dev only): drive real agent tool calls through /mcp so the member's pages
// show realistic memories, life-admin records, tasks, agent reports and pending approvals.
// usage: node seed-content.mjs <acct> [worst]
import { readFileSync } from "node:fs";
import { call } from "./mcp.mjs";

const [acct, mode] = process.argv.slice(2);
const state = JSON.parse(readFileSync(new URL(`./state/${acct}.json`, import.meta.url), "utf8"));
const [claude, chatgpt, gemini] = state.agents.map((a) => a.token);
let ok = 0, bad = 0;
const go = async (token, tool, args) => {
  const r = await call(token, tool, args);
  if (r.ok) ok++; else { bad++; console.log(`✗ ${tool}: ${r.text.slice(0, 160)}`); }
  return r;
};
const runOf = async (token, working_on) => {
  const r = await call(token, "get_context", { reason: "Starting a conversation", working_on });
  return r.text.match(/run[^a-z0-9]+([a-z0-9_-]{8,64})/i)?.[1];
};
const d = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

// Conversations (runs) so the agent pages have "Recent conversations".
const r1 = await runOf(claude, "Sorting out the car registration and insurance renewals");
const r2 = await runOf(gemini, "Planning the Queenstown trip in January");
const r3 = await runOf(chatgpt, "Weekly household admin");

const memories = [
  [claude, "Prefers aisle seats on long flights, window on short hops"],
  [claude, "Allergic to penicillin — always mention it when booking medical appointments"],
  [gemini, "Partner is Sam; kids are Mia (9) and Leo (6). Mia does swimming on Saturdays at 8am"],
  [gemini, "Likes boutique hotels over chains; budget around $250 a night in NZ"],
  [chatgpt, "Bins go out Sunday night: red every week, yellow and green alternate"],
  [chatgpt, "Prefers emails drafted in a short, direct tone with no sign-off emoji"],
  [claude, "Car is a 2019 Mazda CX-5, plate ABC12D (NSW); rego due in December"],
  [gemini, "Vegetarian on weekdays, eats fish on weekends"],
  [chatgpt, "Works from home Mondays and Fridays; office in Surry Hills otherwise"],
  [claude, "Accountant is Priya at Harbour Tax; lodges by 31 October each year"],
];
for (const [t, content] of memories) await go(t, "remember", { content, reason: "Worth keeping for next time" });

const records = [
  { type: "vehicles.vehicle", fields: { name: "Mazda CX-5", make: "Mazda", model: "CX-5", body: "SUV" }, ref: "car" },
  { type: "vehicles.registration", fields: { name: "Car registration", provider: "Service NSW", plate: "ABC12D", state: "NSW", term: "12 months", amount: "912.00", currency: "AUD", cycle: "yearly" }, dueDate: d(18), parentRef: "car" },
  { type: "vehicles.insurance", fields: { name: "Comprehensive car insurance", provider: "AAMI", reference: "MPA-204511", cover: "Comprehensive", excess: "800", amount: "1250.50", currency: "AUD", cycle: "yearly" }, dueDate: d(25), parentRef: "car" },
  { type: "vehicles.service", fields: { name: "Logbook service", provider: "Mazda Parramatta", odometer: "48,200 km", amount: "389", currency: "AUD" }, dueDate: d(40), parentRef: "car" },
  { type: "health.insurance", fields: { name: "Family health cover", provider: "Medibank", reference: "M-88123344", hospital_cover: "Silver Plus", extras_cover: "Top extras", amount: "412.60", currency: "AUD", cycle: "monthly" } },
  { type: "health.appointment", fields: { name: "Dentist check-up for Mia", provider: "Bondi Dental", starts_at: `${d(9)}T15:30`, place: "Bondi Junction" } },
  { type: "utilities.energy", fields: { name: "Electricity and gas", provider: "AGL", plan: "Value Saver", amount: "186", currency: "AUD", cycle: "monthly" } },
  { type: "utilities.internet", fields: { name: "Home internet", provider: "Aussie Broadband", plan: "NBN 100/20", amount: "89", currency: "AUD", cycle: "monthly" } },
  { type: "subscriptions.service", fields: { name: "Netflix", provider: "Netflix", plan: "Standard", amount: "18.99", currency: "AUD", cycle: "monthly" } },
  { type: "subscriptions.service", fields: { name: "Spotify Family", provider: "Spotify", plan: "Family", amount: "22.99", currency: "AUD", cycle: "monthly" } },
  { type: "subscriptions.service", fields: { name: "Paramount+", provider: "Paramount", plan: "Standard", amount: "9.99", currency: "AUD", cycle: "monthly", trial_ends: d(5) } },
  { type: "subscriptions.membership", fields: { name: "Gym membership", provider: "Fitness First", tier: "Platinum", amount: "32", currency: "AUD", cycle: "weekly", how_to_cancel: "In person with 30 days notice" } },
  { type: "travel.trip", fields: { name: "Queenstown family trip", place: "Queenstown, NZ", starts_at: `${d(48)}T00:00`, ends_at: `${d(56)}T00:00` }, ref: "trip" },
  { type: "travel.flight", fields: { name: "SYD → ZQN", provider: "Qantas", reference: "QF121 · 6KXR2P", starts_at: `${d(48)}T07:10`, place: "Sydney Airport T1" }, parentRef: "trip" },
  { type: "travel.stay", fields: { name: "Hotel St Moritz", provider: "Booking.com", reference: "4471229913", starts_at: `${d(48)}T15:00`, ends_at: `${d(56)}T10:00`, place: "Queenstown" }, parentRef: "trip" },
  { type: "travel.car_hire", fields: { name: "Car hire", provider: "Avis", reference: "AV-778120", starts_at: `${d(48)}T11:00`, ends_at: `${d(56)}T08:00` }, parentRef: "trip" },
  { type: "outings.restaurant", fields: { name: "Dinner at Firedoor", provider: "Firedoor", starts_at: `${d(3)}T19:30`, place: "Surry Hills" } },
  { type: "outings.event", fields: { name: "The Teskey Brothers", provider: "Ticketek", reference: "TK-90021", starts_at: `${d(21)}T20:00`, place: "Enmore Theatre" } },
  { type: "government.fine", fields: { name: "Parking fine — Bondi Rd", provider: "Waverley Council", reference: "PN-3349182", opened_on: d(-6), stage: "Waiting to pay", next_step: "Pay before the due date or ask for a review", amount: "121", currency: "AUD" }, dueDate: d(12) },
  { type: "insurance.claim", fields: { name: "Cracked windscreen claim", provider: "AAMI", reference: "CLM-55102", opened_on: d(-14), stage: "Assessing", next_step: "Wait for the assessor to call" }, parentRef: "car" },
  { type: "id.passport", fields: { name: "Alexandra's passport", provider: "Australian Passport Office", country: "Australia" }, dueDate: d(150) },
  { type: "id.driver_licence", fields: { name: "Driver licence", provider: "Service NSW", state: "NSW", licence_class: "C" }, dueDate: d(400) },
  { type: "investing.super", fields: { name: "Super", provider: "AustralianSuper", product: "Balanced" } },
  { type: "pets.pet", fields: { name: "Biscuit", species: "Dog", breed: "Cavoodle", born_on: "2021-03-02" }, ref: "dog" },
  { type: "pets.appointment", fields: { name: "Biscuit's vaccination", provider: "Bondi Vet", starts_at: `${d(30)}T10:00` }, parentRef: "dog" },
];
const extra = mode === "worst" ? Array.from({ length: 90 }, (_, i) => ({ type: i % 3 ? "subscriptions.service" : "other.item", fields: { name: `${i % 7 === 0 ? "Supercalifragilisticexpialidocious-unbroken-subscription-name-that-goes-on-and-on" : "Streaming add-on"} ${i + 1}`, provider: i % 5 === 0 ? "A provider with an extremely long trading name Pty Ltd (Australia & New Zealand)" : "Acme", amount: String((i * 3.7 + 4).toFixed(2)), currency: i % 11 === 0 ? "NZD" : "AUD", cycle: ["monthly", "yearly", "weekly"][i % 3] } })) : [];
const all = [...records, ...extra];
// Save in batches; the agent is "Claude" for car, "Gemini" for trip/family, "ChatGPT" for the rest.
const batches = [[claude, all.slice(0, 4)], [claude, all.slice(4, 6)], [chatgpt, all.slice(6, 12)], [gemini, all.slice(12, 16)], [chatgpt, all.slice(16, 20)], [claude, all.slice(20, 25)]];
for (let i = 25; i < all.length; i += 10) batches.push([chatgpt, all.slice(i, i + 10)]);
const ids = {};
for (const [t, recs] of batches) {
  if (!recs.length) continue;
  const r = await go(t, "save_record", { records: recs, reason: "Found in your email", run: t === claude ? r1 : t === gemini ? r2 : r3 });
  for (const m of r.text.matchAll(/([0-9a-f]{8}-[0-9a-f-]{27})/g)) ids[m[1]] = true;
}

// Tasks.
for (const [t, title, assignee] of [
  [claude, "Renew the car registration before it lapses", "Claude"],
  [claude, "Chase AAMI about the windscreen claim", "Claude"],
  [gemini, "Book ski lessons for Mia and Leo in Queenstown", "Gemini"],
  [chatgpt, "Cancel Paramount+ before the trial ends", "ChatGPT"],
  [chatgpt, "Pay the Waverley Council parking fine", "Me"],
  [gemini, "Find a dog sitter for Biscuit while we're away", "Gemini"],
]) await go(t, "create_task", { title, assignee, reason: "Keeping track" });

// Agent reports (activity), some with spend.
for (const [t, reason, amount, run] of [
  [claude, "Compared three comprehensive car insurance quotes; AAMI renewal is cheapest by $84", undefined, r1],
  [gemini, "Shortlisted four hotels in Queenstown under $250 a night", undefined, r2],
  [gemini, "Booked the Avis car hire for the Queenstown trip", 412.5, r2],
  [chatgpt, "Drafted a reply to the school about the excursion permission note", undefined, r3],
  [chatgpt, "Summarised this week's bills: $1,140 due in the next 14 days", undefined, r3],
  [claude, "Paid the logbook service deposit with the card you released", 120, r1],
]) await go(t, "log_activity", { reason, ...(amount ? { amount, currency: amount === 412.5 ? "NZD" : "AUD" } : {}), run });

// Pending approvals: protected details and card requests.
await go(claude, "request_identity_detail", { field: "driver_licence", purpose: "Fill in the Service NSW registration renewal form", reason: "Renewing your rego", run: r1 });
await go(gemini, "request_identity_detail", { field: "passport", purpose: "Add passport details to the Qantas booking for international check-in", reason: "Airline needs it before check-in opens", run: r2 });
await go(claude, "request_card", { amount: 912, currency: "AUD", merchant: "Service NSW", reason: "Renewing the Mazda's registration for 12 months", run: r1 });
await go(gemini, "request_card", { amount: 180, currency: "NZD", merchant: "Coronet Peak Snow School", reason: "Two half-day ski lessons for Mia and Leo", run: r2 });
await go(gemini, "request_card", { amount: 64.9, currency: "AUD", merchant: "Mad Paws", reason: "Deposit for Biscuit's dog sitter", run: r2 });

console.log(`done: ${ok} ok, ${bad} failed`);
