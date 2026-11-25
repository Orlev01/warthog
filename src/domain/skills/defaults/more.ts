// The second wave of Warthog's default skills (on for everyone) and the opt-in packs (off until
// the person switches one on). Guidance only: the ground rules in "Using Warthog" and the server's
// checks carry the safety (./types.ts), so these texts say how to do a job well, not what's allowed.
//
// Every tool and record kind named here is a real one: more.test.ts checks them against the tool
// registry and the life-admin catalogue.
//
// Pure domain module: no React, no DB, no fetch, no process.env.

import type { DefaultSkillText } from "./types";

const tripPlanning: DefaultSkillText = {
  key: "trip_planning",
  title: "Planning a trip",
  useThisWhen:
    "when the person is planning or has booked a trip or holiday: flights, hotels, an Airbnb, car hire, transfers, travel insurance, an itinerary, or whether their passport is OK to travel",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "Use this to keep one trip together in Life admin, so the person and any agent can see every booking, what's still to do and when free cancellation ends. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for a single restaurant, show or appointment booking: save that on its own.",
    "",
    "1. Look for the trip first: list_records with type travel.trip, or the destination as query. If it's there, add new bookings to it by its id (parentId), so everything stays in one place.",
    "2. Gather the bookings from the person and from confirmation emails: booking confirmations, itineraries, e-tickets, \"your stay\".",
    "3. Save it all in one save_record call. Give the trip a ref (say \"trip\") and give every other record parentRef \"trip\":",
    "- travel.trip, named the way the person says it (\"Bali in March\"), with its destination.",
    "- travel.flight, one per leg. A return trip is two flights, so each keeps its own flight number and time.",
    "- travel.stay for each hotel or Airbnb, travel.car_hire, travel.transport for trains, ferries and transfers, and travel.tour for activities.",
    "- travel.insurance for the trip's cover, with its emergency phone.",
    "Leave out passport and visa numbers. They live in the person's Vault, and save_record refuses them anyway.",
    "4. Check their documents: list_records with type id.passport and id.visa, and compare each expiry date with the return flight. Many countries want a passport valid for six months beyond the trip, and some want a visa or travel authorisation. Entry rules change, so point the person to the destination's page on Smartraveller rather than stating a rule as fact. A document that expires too soon becomes a journal next step on the trip, with a due date.",
    "5. For every booking with a cancel_by date, add a journal next step due a day or two before it (\"Decide on the Ubud villa before free cancellation ends\"). That's what lets a later agent remind the person in time.",
    "6. If you can use their calendar, add the flights and stays as events with no guests (google-calendar__create or microsoft-outlook-calendar__create). Guests would be sent an invitation the person didn't ask for.",
    "",
    "Anything that needs a card, to book or to pay a deposit, follows \"Paying for something\".",
    "",
    "What to give back: the trip as saved, its bookings in date order, any document that expires too soon, and the cancellation deadlines coming up.",
  ].join("\n"),
};

const taxTime: DefaultSkillText = {
  key: "tax_time",
  title: "Tax time",
  useThisWhen:
    "when it's tax time: the tax return, EOFY, myGov pre-fill, work-related deductions, donation or super contribution receipts, a tax agent, or what's left on a HELP debt",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "Use this to help the person get ready for their tax return: what's due when, what they have and what's missing. You organise; the person lodges, or their registered tax agent does. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for a business's BAS or PAYG instalments: the \"Sole trader\" pack covers those.",
    "",
    "How the year runs. The Australian financial year ends on 30 June. A return the person lodges themselves is usually due by 31 October. Through a registered tax agent it's usually later, if they're on the agent's books before 31 October. myGov pre-fill (income, interest, private health) is usually ready from late July, so lodging earlier often means typing in what pre-fill would have added.",
    "",
    "1. Call list_records with type government.lodgement. Save or update one for the year: lodgement_kind \"tax return\", period such as \"FY2026\" for the year ending 30 June 2026, the due date, and the tax agent as provider if they use one. The kind and period identify it, so saving it again updates it.",
    "2. Search their email for the year's receipts for work expenses, donations (\"tax deductible\", \"DGR\") and personal super contributions. Keep them as one summary in the lodgement's notes field, grouped by type, with each one's merchant, date and amount. One note is easier for the person to check than a record per receipt.",
    "3. For each document still missing (a payment summary, a donation receipt, the super fund's letter acknowledging a contribution claim), create a task with create_task and the lodgement's id as recordId. If you can't use tasks, add a journal next step on the lodgement instead.",
    "4. If they have a HELP debt, keep its balance in government.help. There's only one, so update it rather than adding another.",
    "",
    "Sole traders also report business income and expenses, and may have BAS as well. The \"Sole trader\" pack covers that part.",
    "",
    "Keep the tax file number out of every record, note and task. Warthog refuses it, and the law limits who may hold one. Don't tell the person what they can claim or what refund to expect: that's tax advice, which belongs to their tax agent or ato.gov.au.",
    "",
    "The ATO doesn't send links to log in. Treat an \"ATO\" email with a login link, a refund to claim or a threat as a likely scam: say so, and suggest the person goes to my.gov.au themselves.",
    "",
    "What to give back: the due date, what you gathered, what's missing, and the tasks you made.",
  ].join("\n"),
};

const inboxCatchUp: DefaultSkillText = {
  key: "inbox_catch_up",
  title: "Inbox catch-up",
  useThisWhen:
    "when the person asks to catch up on email: what's new or unread, what came in this week, what needs a reply, or a quick summary of their inboxes",
  requires: ["mail_read"],
  version: 1,
  guidance: [
    "Use this to give the person a short, sorted view of what's new in their email, so they can decide what to deal with. The ground rules are in \"Using Warthog\".",
    "",
    "Not for finding one particular email, or for combing email for one kind of paperwork: search for that directly, or follow \"Life admin records\".",
    "",
    "1. Search once per mail service with no account: that one search covers every inbox of the service, and each result says which inbox it's in.",
    "- Gmail: google-gmail__search with query.q \"is:unread newer_than:7d\" and query.maxResults 25.",
    "- Outlook: microsoft-outlook-mail__search takes words plus a date, not Gmail's newer_than. Put received>=YYYY-MM-DD for a week ago in query.$search, with query.$top 25. Each result says isRead, so leave out the ones already read.",
    "2. Work from the search results first. Sender, subject, date and preview are usually enough to sort an email. Read one in full (google-gmail__read or microsoft-outlook-mail__read) only when the preview can't tell you what it needs; in Gmail, query.format=metadata reads the headers alone.",
    "3. Sort them into five groups, naming each email's inbox:",
    "- Needs a reply: a real person asking something, or a deadline.",
    "- Bills: who, how much and when it's due.",
    "- Bookings: confirmations, changes and cancellations.",
    "- Deliveries: tracking and \"out for delivery\".",
    "- FYI: newsletters, receipts and notices that need nothing.",
    "Keep each line short: who, what, and the date that matters.",
    "4. List likely phishing on its own: an \"ATO\" refund or debt, an unpaid toll, a parcel that \"couldn't be delivered\", or any urgent link to pay or log in. Say why it looks wrong (the sender's address, where the link goes), and don't follow its links.",
    "5. If you may save to Life admin, offer to save the bills and bookings, following \"Life admin records\", so they're tracked after the email scrolls away.",
    "6. Offer replies as drafts (google-gmail__draft or microsoft-outlook-mail__draft, with the email's id as reply.id). Send one only when the person asks you to.",
    "",
    "You can't archive, label, move or mark email as read: Warthog's mail tools search, read, draft and send. When the person asks, say so plainly and leave it there rather than looking for another way in. They can tidy up in their mail app.",
    "",
    "What to give back: the five groups with a count each, the suspected scams, and what you can save or draft.",
  ].join("\n"),
};

const businessProblem: DefaultSkillText = {
  key: "business_problem",
  title: "Sorting out a problem with a business",
  useThisWhen:
    "when something bought or paid for has gone wrong: a refund, a faulty or broken item, a warranty claim, an overcharge or wrong bill, or a complaint to a business or an ombudsman",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "Use this to help the person see a problem with a business through to the end, and keep it in Life admin so any agent can pick it up. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for a fine (government.fine) or a tax matter (\"Tax time\").",
    "",
    "1. Look for it first: list_records with lifecycle \"case\" and the business's name as query.",
    "2. Keep it as one case record. insurance.claim is for an insurance claim, home.repair for a repair the landlord or agent owes, and other.case for anything else: a refund, a faulty item, a billing error, a complaint. Fill provider (the business), reference (their case or order number), opened_on, next_step and waiting_on, and set status to open. Link it with parentId to the saved vehicle, home, trip or valuable it's about. A case can't belong to a receipt, so put the receipt's order number in its reference or notes.",
    "3. Explain the person's rights in plain words, as information rather than legal advice. Under the Australian Consumer Law, goods and services come with guarantees that don't depend on any warranty: they must be of acceptable quality, fit for purpose and as described. For a major failure with goods the person can choose a refund or a replacement, or keep them and be compensated for the drop in value. For a minor one the business may choose to repair, replace or refund, but must do it within a reasonable time. The ACCC and the state's fair trading office explain the details.",
    "4. Follow the usual path, one step at a time:",
    "- The business first, in writing: what went wrong and what the person wants.",
    "- If that fails, the industry's ombudsman: AFCA for banks, insurers and super, the Telecommunications Industry Ombudsman for phone and internet, the state's energy and water ombudsman. Most expect the business to have had a fair chance first.",
    "- Then the state's tribunal: NCAT in NSW, VCAT in Victoria, or its equivalent elsewhere.",
    "5. Draft each message for the person to read. Use their mail's draft tool if you can, and send only when they ask.",
    "6. After each step, add to the record's journal: a decision when the person picks a path (\"Asked for a refund, not a repair: second fault in a month\") and a next step with a due date (\"Chase if no reply by 12 Dec\"). Set status to waiting while it's with the business, and to resolved, with the outcome, when it's done.",
    "",
    "What to give back: the case as saved, what the person can ask for and why, the draft, and the next step with its date.",
  ].join("\n"),
};

export const SECOND_WAVE_SKILLS: readonly DefaultSkillText[] = [tripPlanning, taxTime, inboxCatchUp, businessProblem];

const schoolFamily: DefaultSkillText = {
  key: "school_family",
  title: "School and family",
  useThisWhen:
    "when it's about the kids: school or childcare emails, term dates, excursions, permission notes, school fees, Child Care Subsidy, sport and lessons, or immunisations due",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "This pack helps the person keep up with their children's school, childcare and activities, and the emails that come with them. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for an ageing parent (\"A parent's affairs\") or a family holiday (\"Planning a trip\").",
    "",
    "Use children's first names only, in the child's record and in for_whom. A first name is all an agent needs to tell them apart, and it keeps less about a child in one place.",
    "",
    "1. See what's saved: list_records with category family.",
    "2. Find the school mail: the school's or centre's name, or words like \"term\", \"excursion\", \"permission\", \"fees\", \"newsletter\" and \"Child Care Subsidy\".",
    "3. Save what lasts in one save_record call. Give each child a ref, and their other records parentRef:",
    "- family.child: first name, school and year.",
    "- family.school: the school, childcare or OSHC, when fees are due, and the Child Care Subsidy percentage in ccs_percent when the person has it from Centrelink.",
    "- family.activity: a sport, club or lesson, with when its fees are due.",
    "- family.immunisation: what's due and when, as the schedule names it (\"4-year-old immunisations\"). Leave out reactions, conditions and anything else about the child's health: a reminder doesn't need them.",
    "4. Turn one-off dates into calendar events with no guests: an excursion, a pupil-free day, photo day, a concert. Guests would get an invitation they didn't ask for.",
    "5. Turn things to do into tasks with create_task: a permission note to sign, a payment, a uniform to buy. If you can't use tasks, add them as journal next steps on the school record.",
    "",
    "Term dates differ by state, and some private schools set their own. Take them from the school's email or the state education department's website rather than from memory, and say which you used.",
    "",
    "What to give back: what you saved for each child, the dates coming up, and what needs the person's signature or payment.",
  ].join("\n"),
};

const parentsAffairs: DefaultSkillText = {
  key: "parents_affairs",
  title: "A parent's affairs",
  useThisWhen:
    "when the person helps look after an ageing parent: My Aged Care, Support at Home, Centrelink, a concession card, their appointments or script repeats, or a power of attorney",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "This pack helps the person keep track of a parent's affairs while they help manage them. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for the person's own health or money, or for their children (\"School and family\").",
    "",
    "Keep to what the person shares. You work for the person, not the parent, so save what they tell you or what reaches their own email, and don't go looking for more. The parent has their own privacy.",
    "",
    "Put the parent in for_whom on every record (\"Mum\", \"Dad\" or a first name), so their records stay apart from the person's own. list_records with forWhom \"Mum\" then shows just hers. Some kinds keep one record per kind (a government payment, an aged care plan): when the second parent has one too, save it with onMatch \"create\", or it updates the first parent's.",
    "",
    "What to keep:",
    "- care.plan for a My Aged Care or Support at Home plan: plan_kind \"aged care\", the provider, and when it's reviewed.",
    "- care.service for each service under it (cleaning, nursing, meals, transport), with when its agreement ends.",
    "- health.appointment for each appointment, with the clinic and time. Name it by the clinic or practitioner rather than by what it's for.",
    "- health.script for when a repeat is due, called something only the family would understand (\"Mum's morning script\"). Leave the medicine and the condition out: a reminder doesn't need them, and they're the most sensitive things you could keep.",
    "- government.payment for a Centrelink payment such as the Age Pension, with when reporting is due. A concession card, such as a Pensioner Concession Card or Commonwealth Seniors Health Card, goes on it as a detail with its expiry. Leave out the Customer Reference Number and any card or reference number: those stay in the Vault, out of records.",
    "- legal.document for a power of attorney or enduring guardianship (document_kind \"power of attorney\" or \"guardianship\"): that it exists, where it's kept (kept_at) and who's named. Leave out what it says. Where it is and who holds it is what an agent may need; its terms are the parent's business.",
    "",
    "Follow-ups, like a reassessment, a card renewal or a form to send, go in as journal next steps with a due date, so whoever helps next sees them. If the person drives the parent to appointments, offer calendar events with no guests.",
    "",
    "What to give back: what you saved under the parent's name, what's coming up in the next month, and anything waiting on the person.",
  ].join("\n"),
};

const soleTrader: DefaultSkillText = {
  key: "sole_trader",
  title: "Sole trader",
  useThisWhen:
    "when the person runs a small business as a sole trader: their ABN or business name, BAS and GST, PAYG instalments, invoices and late payers, or business insurance renewals",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "This pack helps a sole trader keep the business's paperwork and due dates in one place. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for the person's own tax return: \"Tax time\" covers that, and points here for the business part.",
    "",
    "The business. Save it as business.entity with its name, structure \"sole trader\" and ABN. An ABN is public, so it's fine to keep. Give it a ref and its other records parentRef, or its id as parentId later:",
    "- business.registration for the business name, with when it renews.",
    "- business.insurance for public liability or professional indemnity, with its renewal date. Add a journal next step a few weeks before it, to compare quotes.",
    "- business.domain for the website's domain and hosting.",
    "",
    "Lodgements. Save each as government.lodgement:",
    "- BAS, when the business is registered for GST. A quarterly BAS is usually due on 28 October, 28 February, 28 April and 28 July. Use lodgement_kind \"BAS\" and a period such as \"Jul–Sep 2026\". A registered BAS or tax agent may have later dates: use the ones the agent gives.",
    "- PAYG instalments, when the ATO has asked for them: lodgement_kind \"PAYG instalment\", or \"IAS\" when they come on an instalment activity statement.",
    "Receipts go in one summary in the lodgement's notes field, grouped by type, as \"Tax time\" does. A record per receipt is more than the person can check.",
    "",
    "Getting paid. Track each unpaid invoice as other.case: the client as provider, the invoice number as reference, the amount, its due date, and status open. When it's overdue, draft a polite reminder for the person to send, then a firmer one, and add a journal next step for each chase. Set it to resolved when it's paid. A one-off to-do can be a task instead (create_task).",
    "",
    "Don't tell the person whether they need to register for GST, what they can claim or how much to put aside. That's tax advice, and it turns on thresholds that change: point them to ato.gov.au or their tax agent.",
    "",
    "What to give back: the due dates coming up, the invoices outstanding and how late each is, and the renewals in the next two months.",
  ].join("\n"),
};

const newToAustralia: DefaultSkillText = {
  key: "new_to_australia",
  title: "New to Australia",
  useThisWhen:
    "when the person has recently moved to Australia: their visa and VEVO, enrolling in Medicare, Lifetime Health Cover, getting a TFN, super, a bank account, or converting an overseas licence",
  requires: ["records_write"],
  version: 1,
  guidance: [
    "This pack helps someone who has recently moved to Australia get set up without missing a deadline. Each kind's fields are in \"Life admin records\"; the ground rules are in \"Using Warthog\".",
    "",
    "Not for migration advice. Whether a visa can be extended, changed or applied for is a question for a registered migration agent or the Department of Home Affairs: say so, and point the person there.",
    "",
    "- Visa: save it as id.visa with the country, visa type or subclass, its conditions (such as work limits) and its expiry as the due date. Leave out the grant number: it belongs in the person's Vault, and save_record refuses it. Conditions can change, so the person checks their current ones on VEVO, Home Affairs' online check, rather than relying on what's saved.",
    "- Medicare: whether they can enrol depends on their visa, and for some on an agreement with their home country. While they apply, keep it as government.application; once the card arrives, save id.medicare with when it's valid to.",
    "- Lifetime Health Cover: explain it plainly. Someone who takes out private hospital cover after their deadline pays a loading on top of the premium for years. For someone who arrived after turning 31, the deadline is usually a year after they're registered for full Medicare. Point them to privatehealth.gov.au to check their own date, and keep it as other.reminder so it isn't missed. Cover they take out goes in health.insurance.",
    "- Tax file number: help them apply through the ATO, but keep the TFN itself out of every record, note and task. The law limits who may hold one, and the person gives it to an employer or fund themselves.",
    "- Super: save the fund as investing.super, with the member number and USI a new employer asks for.",
    "- Bank: save each account as banking.account, with the bank and the last 4 digits only.",
    "- Driver licence: an overseas licence can usually be used for a while, but how long, and whether a test is needed, differ by state. Check the state's transport website (Service NSW, VicRoads and the like) and keep the deadline as a journal next step. Once it's converted, save id.driver_licence with the state and expiry.",
    "- A lease, phone plan or internet go in home.lease, utilities.phone and utilities.internet.",
    "",
    "Dates and rules here change. Say where each one came from and when you checked, rather than stating it from memory.",
    "",
    "What to give back: what you saved, the deadlines with their dates (visa, Lifetime Health Cover, licence), and what the person still has to do themselves.",
  ].join("\n"),
};

export const PACK_SKILLS: readonly DefaultSkillText[] = [schoolFamily, parentsAffairs, soleTrader, newToAustralia];
