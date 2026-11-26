import * as React from "react";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  BookOpen,
  CalendarClock,
  CalendarDays,
  Car,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  CreditCard,
  Download,
  Fingerprint,
  HeartPulse,
  Landmark,
  Link2,
  ListChecks,
  ListTodo,
  LockKeyhole,
  MailCheck,
  MailSearch,
  Receipt,
  Repeat,
  ShieldCheck,
  SlidersHorizontal,
  Tv,
  Users,
  Wallet,
} from "lucide-react";

import { RELATIVE_LINKS, type PublicLinks } from "@/server/http/public-links";
import { Wordmark } from "../shell/wordmark";
import { SUPPORT_EMAIL } from "./operator";
import { PolicyLinks } from "./policy-links";
import { AskFirstFlow, ConnectOnceDiagrams, SharedMemoryFlow } from "./landing-diagrams";
import { LandingBackdrop, LandingMotion, LandingMotionControl } from "./landing-motion";

const STEPS = [
  {
    icon: Link2,
    title: "Connect your services once",
    body: "Bring your supported services into one home. Choose what to connect, and keep each connection under your control.",
  },
  {
    icon: Bot,
    title: "Connect your agents",
    body: "Give each compatible agent its own connection, with access shaped around the job you want it to do.",
  },
  {
    icon: ShieldCheck,
    title: "Approve and see everything",
    body: "Review requests that need your approval and follow activity through Warthog, with a record you can come back to.",
  },
] as const;

// A few of the services people connect most, as plain names (never logos). The catalogue
// holds more than 100 (catalogue/connectors); Google's are in early access.
const SERVICES = ["Gmail", "Outlook", "Google Calendar", "Google Drive", "OneDrive", "Notion", "Todoist", "GitHub"] as const;

const CONTROLS = [
  {
    icon: SlidersHorizontal,
    title: "The right access for each agent",
    body: "Choose the resources and actions each agent can use. Give your research assistant different permissions from your personal organiser.",
  },
  {
    icon: ShieldCheck,
    title: "Your say before the next step",
    body: "Set approval rules and spending limits for requests through Warthog. Review sensitive requests before they go ahead, with exactly what will go out in front of you.",
  },
  {
    icon: MailCheck,
    title: "Checked before your agents read it",
    body: "Emails, events and files reach your agents marked as written by someone else, with sign-in codes and password-reset links held back. An approval flags the first email to someone you’ve never written to.",
  },
  {
    icon: ListChecks,
    title: "A clearer picture of what happened",
    body: "See requests, decisions and outcomes together, conversation by conversation. Undo an action that can be undone, like an event an agent added, and disconnect an agent when its job is done.",
  },
] as const;

const SPENDING = [
  {
    icon: CreditCard,
    title: "One card, one purchase",
    body: "The agent says what it’s buying, from whom and for how much. You confirm it’s you, enter the security code, and the agent collects the card once. The security code is never kept.",
  },
  {
    icon: Wallet,
    title: "Budgets checked first",
    body: "Give each agent a budget, a limit per purchase and the shops it may or may not use. A request outside them is refused before it reaches you.",
  },
  {
    icon: Users,
    title: "A budget for the household",
    body: "Share a monthly household budget, with a limit for each member. Everyone sees the totals; no one sees each other’s purchases or cards.",
  },
] as const;

const RESOURCES = [
  {
    icon: BookOpen,
    title: "Memory & skills",
    body: "Keep useful context and reusable instructions in one place, and decide which agents can use them. A skill you write with one AI can be saved here by that AI. No agent uses it until you’ve checked it.",
  },
  {
    icon: LockKeyhole,
    title: "A personal vault",
    body: "Keep your address, preferences and documents in one place. Passport, licence and card details are locked on your own device and released only when you approve.",
  },
  {
    icon: ListTodo,
    title: "Tasks to hand over",
    body: "Share a task list with your agents. Hand a job to one agent, or any of them, and let one agent’s findings become another’s next step.",
  },
  {
    icon: Download,
    title: "Yours to take with you",
    body: "Your memory, skills and preferences don’t belong to any one AI provider. Export everything in an open format, with skills as plain text other tools can use.",
  },
] as const;

const LIFE_ADMIN = [
  {
    icon: MailSearch,
    title: "Filled in from your email",
    body: "Your own agent searches your email through Warthog and saves what it finds. It waits for you to confirm it, and Warthog won’t keep tax file numbers, passwords, card or bank account numbers, or medical details.",
  },
  {
    icon: CalendarClock,
    title: "What’s active, first",
    body: "Records holds what you have now: vehicles, home, health, money and more, with each account’s name, number and email. Upcoming holds what needs you or is booked. History holds what’s finished. Reminders come before renewals and expiry dates.",
  },
  {
    icon: Repeat,
    title: "Any agent can carry it on",
    body: "Each item keeps a short log of decisions and next steps, so another agent, from any provider, can pick up where the last one stopped.",
  },
] as const;

const FAQS = [
  {
    question: "Do I use Warthog instead of my AI assistant?",
    answer:
      "Keep using your preferred assistant. Warthog is the place you manage what a compatible agent can access through its Warthog connection. It does not run an AI model or replace your conversations.",
  },
  {
    question: "Which agents and services can I connect?",
    answer: (
      <>
        Connection availability varies by platform and plan. Start with the{" "}
        <a href="/help/compatibility">compatibility guide</a> for agent setup.
        Inside Warthog, the service catalogue shows what you can connect; some
        services, including Google connections, may require early access.
      </>
    ),
  },
  {
    question: "Is there an app for my phone?",
    answer:
      "Add Warthog to your phone’s home screen from the browser, on iPhone or Android, and turn on notifications. A request that needs you arrives as a notification within seconds and opens straight onto it. If you haven’t opened it after a few minutes, an email follows. You always decide inside Warthog, never by replying to a message.",
  },
  {
    question: "Can I change my mind about access?",
    answer:
      "Yes. Update an agent’s permissions or disconnect it from Warthog. Disconnecting stops new requests through that connection. It cannot recall information already shared or disconnect tools you have linked directly elsewhere.",
  },
  {
    question: "Does Warthog control everything an agent does?",
    answer:
      "Warthog’s permissions, approval rules and activity record apply only to requests made through Warthog. Tools, conversations, spending and private memory managed directly by another provider remain outside that connection.",
  },
] as const;

// Plain answers to "where does my data go and how am I protected?". Each claim must stay
// true to the code and the privacy policy: no "end-to-end", no certifications, and the
// staff claim covers only what staff tools display and the device-encrypted tier.
const SECURITY_FAQS = [
  {
    question: "Where is my information stored?",
    answer: (
      <>
        Warthog is hosted in Australia, in Microsoft Azure’s Australia East region. Your
        information is kept in a private database that can’t be reached from the internet,
        only by Warthog’s own systems. A few services Warthog relies on work outside
        Australia, such as the one that delivers Warthog’s emails to you. The{" "}
        <a href="/privacy">privacy policy</a> explains which.
      </>
    ),
  },
  {
    question: "How is my information protected?",
    answer:
      "Everything between you, your agents and Warthog travels over an encrypted connection. Once stored, your details, memory, skills, records, activity and service connections are encrypted with a key that belongs to your account alone. That key is locked in turn by a separate key held in Microsoft’s protected key storage, so your stored information can’t be read without it.",
  },
  {
    question: "What about my passport, licence and card details?",
    answer:
      "These get an extra layer. They’re encrypted on your own device, with a key that stays with you, before they reach Warthog, so Warthog only ever stores the locked version. While they’re stored, Warthog’s servers can’t read them and neither can our staff. When you approve a request, your device unlocks just that one detail. Warthog hands it to the agent once, then discards it. We never keep a card’s security code.",
  },
  {
    question: "Who decides what each agent can see and do?",
    answer:
      "You do. Each agent has its own connection and its own permissions, which you set service by service and detail by detail. New agents start with your sensitive details and cards switched off, and ask you before making changes in your connected services, such as sending an email. A request for a sensitive detail or a card asks you every time, and you approve it in Warthog itself, not in the agent’s chat. Agents never get the passwords to your services.",
  },
  {
    question: "Can Warthog’s staff see my information?",
    answer:
      "We only see account-level facts, such as when you signed up and how many agents and services you’ve connected. No staff tool displays your details, memory, records, emails or activity. Your passport, licence and card details are locked on your own device, so our staff can’t unlock them.",
  },
  {
    question: "Does Warthog read my email?",
    answer:
      "Not on its own. Warthog fetches an email only when an agent you’ve allowed asks for it, and passes on a cleaned-up copy with sign-in codes, password reset links and card numbers taken out. It doesn’t keep a copy of your mailbox. The access you give Warthog to each service is stored encrypted, and you can disconnect a service at any time.",
  },
  {
    question: "Does Warthog sell my information or use it to train AI?",
    answer: (
      <>
        No. We never sell any of your information, and there are no ads or third-party
        trackers in Warthog. Warthog doesn’t run an AI model, so it isn’t training one on
        your information. Your information goes only to the agents you connect, when they
        ask and within the permissions you set. Once an agent has it, the agent’s own
        provider handles it under its terms, so it’s worth checking those too. The{" "}
        <a href="/privacy#never-sold">privacy policy</a> sets out our commitment.
      </>
    ),
  },
  {
    question: "Is there a password someone could steal?",
    answer:
      "No, because Warthog doesn’t use sign-in passwords. You sign in with a passkey kept on your own devices and unlocked with your fingerprint, face or device PIN, which a fake website can’t trick out of you. You can also sign in with an emailed code plus an authenticator app. Sensitive steps, such as approving a card for an agent, exporting your data or changing your security settings, ask you to confirm it’s you again.",
  },
  {
    question: "Can the record of what my agents did be changed?",
    answer:
      "Not by your agents. Warthog writes the record itself, covering every request an agent makes through Warthog, every approval and every change to your connections, and agents can’t edit or delete it. Each entry is linked to the one before it, and Warthog checks every day that the chain is unbroken. If it ever finds a break, it tells you.",
  },
  {
    question: "What can other members of my household see?",
    answer:
      "Only what your household shares: the household address, currency and budget, the member list and each member’s spending total. Members never see each other’s details, cards, memory, skills, agents or activity.",
  },
  {
    question: "Can I take my information with me, or delete it?",
    answer: (
      <>
        Yes, both in Settings, once you’ve confirmed it’s you. Export gives you a copy of
        everything you keep in Warthog. Deleting your account cuts off your agents and
        services straight away, signs you out everywhere and schedules your information for
        removal. Backups are cleared on their own schedule, which the{" "}
        <a href="/privacy">privacy policy</a> explains.
      </>
    ),
  },
  {
    question: "Who do I talk to about privacy or security?",
    answer: (
      <>
        Signed in? Use Contact us in Warthog. Otherwise, email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. The{" "}
        <a href="/privacy">privacy policy</a> sets out what we store, where it’s kept and
        who can read it.
      </>
    ),
  },
] as const;

const FAQ_GROUPS = [
  { id: "questions-using", title: "Using Warthog", items: FAQS },
  { id: "questions-security", title: "Security and privacy", items: SECURITY_FAQS },
] as const;

// A semantic, static product illustration. These are labelled examples, not
// account data or pretend interactive controls. No provider logos or remote media.
function WorkspacePreview() {
  return (
    <figure className="wh-landing-preview" aria-labelledby="workspace-caption" data-motion-reveal>
      <div className="wh-landing-preview-bar">
        <span>
          <ShieldCheck size={16} aria-hidden="true" /> Your workspace
        </span>
        <span className="wh-landing-eyebrow">Example</span>
      </div>
      <div className="wh-landing-preview-body">
        <div className="wh-landing-preview-heading">
          <div>
            <p className="wh-landing-small">Overview</p>
            <h2>Your agents, at a glance.</h2>
          </div>
          <span className="wh-landing-icon">
            <Bot size={20} aria-hidden="true" />
          </span>
        </div>
        <p className="wh-landing-preview-label">Connected agents</p>
        <ul className="wh-landing-agent-list">
          <li>
            <span className="wh-landing-icon">
              <BookOpen size={18} aria-hidden="true" />
            </span>
            <div>
              <strong>Research assistant</strong>
              <span>Memory & skills</span>
            </div>
            <span className="wh-landing-badge">Read only</span>
          </li>
          <li>
            <span className="wh-landing-icon">
              <CalendarDays size={18} aria-hidden="true" />
            </span>
            <div>
              <strong>Personal organiser</strong>
              <span>Calendar</span>
            </div>
            <span className="wh-landing-badge">Ask me first</span>
          </li>
        </ul>
        <div className="wh-landing-request">
          <p className="wh-landing-request-status">
            <Clock3 size={15} aria-hidden="true" /> Awaiting your approval
          </p>
          <h3>Create a calendar event</h3>
          <p>
            Your personal organiser wants to add “Weekly planning” to your
            calendar.
          </p>
          <div className="wh-landing-request-rule">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Your rule: ask before making changes</span>
          </div>
        </div>
        <div className="wh-landing-preview-note">
          <Check size={16} aria-hidden="true" />
          <span>Separate permissions. One place to review.</span>
        </div>
      </div>
      <figcaption id="workspace-caption">
        Illustrative workspace · example agents and request
      </figcaption>
    </figure>
  );
}

// The Records list in Life admin, as a static example: made-up items in the shape the app shows
// them (what's active first, the kind and when it's due, where it stands). No account data,
// no controls and no links.
const EXAMPLE_RECORDS = [
  { icon: Car, name: "Car registration", detail: "Vehicles · Expires in 9 days", status: "Due soon" },
  { icon: Landmark, name: "Super fund", detail: "Super and investing · Member number and email on file", status: "Current" },
  { icon: HeartPulse, name: "Health insurance", detail: "Health · Renews 1 Mar", status: "Current" },
  { icon: Tv, name: "Streaming subscription", detail: "Found in your email by your agent", status: "To check" },
] as const;

function LifeAdminPreview() {
  return (
    <figure className="wh-landing-preview wh-landing-life-preview" aria-labelledby="life-admin-caption" data-motion-reveal>
      <div className="wh-landing-preview-bar">
        <span>
          <Receipt size={16} aria-hidden="true" /> Life admin
        </span>
        <span className="wh-landing-eyebrow">Example</span>
      </div>
      <div className="wh-landing-preview-body">
        <p className="wh-landing-preview-label">Active</p>
        <ul className="wh-landing-agent-list">
          {EXAMPLE_RECORDS.map(({ icon: Icon, name, detail, status }) => (
            <li key={name}>
              <span className="wh-landing-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <div>
                <strong>{name}</strong>
                <span>{detail}</span>
              </div>
              <span className="wh-landing-badge">{status}</span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption id="life-admin-caption">Illustrative records · example items</figcaption>
    </figure>
  );
}

// `links` points the brand and account links at the website and the app when the front door
// has its own host (docs/adr/website-root-domain.md); without one they stay relative.
export function Landing({ links = RELATIVE_LINKS }: { links?: PublicLinks } = {}) {
  return (
    <LandingMotion>
      <a className="wh-landing-skip" href="#main-content">
        Skip to content
      </a>
      {/* The brand and account links form the pinned top bar. The section links follow it:
          a strip that scrolls away on phones, drawn inside the sticky bar from 768px
          (public.css), so the bar stays about 64px tall everywhere (mobile-14). */}
      <header className="wh-landing-header">
        <Wordmark href={links.home} />
        <div className="wh-landing-account">
          <a href={`${links.account}/signin`} className="wh-landing-link">
            Sign in
          </a>
          <a
            href={`${links.account}/signup`}
            className="wh-landing-button wh-landing-header-signup"
          >
            Sign up <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </header>
      <nav aria-label="Explore Warthog" className="wh-landing-nav">
        <a href="#your-control">Control</a>
        <a href="#life-admin">Life admin</a>
        <a href="#how-it-works">How it works</a>
        <a href="#questions">Questions</a>
      </nav>

      <main id="main-content" tabIndex={-1}>
        <section className="wh-landing-hero" aria-labelledby="hero-title" data-motion-surface>
          <LandingBackdrop />
          <div className="wh-landing-hero-copy" data-motion-reveal>
            <p className="wh-landing-eyebrow">
              <span className="wh-landing-eyebrow-line" /> A home for your AI
              agents
            </p>
            <h1 id="hero-title">
              Your agents.
              <br />
              <span>Your rules.</span>
            </h1>
            <p className="wh-landing-lead">
              Your agents work for you, on your terms, from your home.
            </p>
            <p className="wh-landing-description">
              Bring your services, information and agents together. Decide what
              each agent can access, what it can do, and when it needs to ask.
            </p>
            <div className="wh-landing-actions">
              <a href={`${links.account}/signup`} className="wh-landing-button">
                Sign up for Warthog <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a href="#how-it-works" className="wh-landing-link">
                See how it works <ArrowDown size={16} aria-hidden="true" />
              </a>
            </div>
            <p className="wh-landing-hero-note">
              <Fingerprint size={16} aria-hidden="true" /> Your permissions.
              Your decisions.
            </p>
            <LandingMotionControl />
          </div>
          <WorkspacePreview />
        </section>

        <section
          className="wh-landing-compatibility"
          aria-labelledby="compatibility-title"
        >
          <div>
            <h2 id="compatibility-title">Bring the agents you already use.</h2>
            <p>
              Connection availability varies by platform and plan. Claude and ChatGPT
              support custom connectors; for Gemini, Grok and Llama-based clients it
              depends on the app you use.
            </p>
          </div>
          <ul aria-label="Agent platforms">
            <li>Claude</li>
            <li>ChatGPT</li>
            <li>Gemini</li>
            <li>Grok</li>
            <li>Llama-based clients</li>
          </ul>
          <a href="/help/compatibility" className="wh-landing-link">
            Check compatibility <ArrowRight size={16} aria-hidden="true" />
          </a>
        </section>

        <section
          id="one-home"
          className="wh-landing-section wh-landing-why"
          aria-labelledby="why-title"
        >
          <div className="wh-landing-section-intro" data-motion-reveal>
            <p className="wh-landing-eyebrow">Why one home</p>
            <h2 id="why-title">
              Connect your services once.
              <br />
              Point every agent at Warthog.
            </h2>
            <p>
              Without a home, every agent needs its own connection to every
              service. With Warthog, each service connects once, each agent
              connects only to Warthog, and you decide what each one may use.
            </p>
          </div>
          <ConnectOnceDiagrams />
          <p className="wh-landing-scope">
            <Link2 size={16} aria-hidden="true" /> Illustration · example agents
            and services. Add a sixth agent: 5 more connections without
            Warthog, 1 with it.
          </p>
        </section>

        <section
          id="services"
          className="wh-landing-compatibility"
          aria-labelledby="services-title"
        >
          <div>
            <h2 id="services-title">Connect the services you already use.</h2>
            <p>
              More than 100 services: email, calendar, files, notes and tasks, messaging,
              travel, finance and developer tools. Some, including Google, are in early
              access. Can’t see yours? Ask for it in Warthog, and we’ll email you when you
              can connect it.
            </p>
          </div>
          <ul aria-label="Some of the services you can connect">
            {SERVICES.map((service) => (
              <li key={service}>{service}</li>
            ))}
          </ul>
        </section>

        <section
          id="your-control"
          className="wh-landing-section wh-landing-controls"
          aria-labelledby="control-title"
        >
          <div className="wh-landing-section-intro" data-motion-reveal>
            <p className="wh-landing-eyebrow">
              Useful agents. Clear boundaries.
            </p>
            <h2 id="control-title">
              Give them room to help.
              <br />
              Keep the decisions yours.
            </h2>
            <p>
              Connecting an agent should come with a clear understanding of what
              you’re allowing. Warthog puts those choices in your hands.
            </p>
            <a href="#how-it-works" className="wh-landing-link">
              From connection to control{" "}
              <ArrowDown size={16} aria-hidden="true" />
            </a>
          </div>
          <div className="wh-landing-control-list">
            {CONTROLS.map(({ icon: Icon, title, body }) => (
              <article key={title} data-motion-reveal>
                <span className="wh-landing-icon">
                  <Icon size={21} aria-hidden="true" />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </article>
            ))}
          </div>
          <AskFirstFlow />
          <p className="wh-landing-scope">
            <CircleHelp size={16} aria-hidden="true" /> These controls apply
            only to requests made through Warthog. Activity through an agent’s
            other tools stays with that provider.
          </p>
        </section>

        <section
          id="spending"
          className="wh-landing-section"
          aria-labelledby="spending-title"
        >
          <div className="wh-landing-section-intro" data-motion-reveal>
            <p className="wh-landing-eyebrow">Spending, within your limits</p>
            <h2 id="spending-title">
              Let an agent pay.
              <br />
              Only on your say{"\u2011"}so.
            </h2>
            <p>
              Save your cards once. When an agent needs one for a purchase, Warthog
              checks your limits, asks you, and hands over the card for that purchase
              alone.
            </p>
          </div>
          <div className="wh-landing-resource-grid">
            {SPENDING.map(({ icon: Icon, title, body }) => (
              <article key={title} data-motion-reveal>
                <Icon size={25} strokeWidth={1.5} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <p className="wh-landing-scope wh-landing-scope-spaced">
            <Wallet size={16} aria-hidden="true" /> What you approve shows on your
            Spending page against each budget. These limits apply to card requests
            through Warthog; card details you’ve given an agent directly stay outside
            them.
          </p>
        </section>

        <section
          id="your-context"
          className="wh-landing-resources wh-landing-section"
          aria-labelledby="resources-title"
        >
          <div className="wh-landing-section-intro" data-motion-reveal>
            <p className="wh-landing-eyebrow">A shared home, chosen access</p>
            <h2 id="resources-title">The context is yours to keep.</h2>
            <p>
              Build a useful home for the information your agents need. Share
              what helps, with the agents you choose.
            </p>
          </div>
          <div className="wh-landing-resource-grid wh-landing-resource-grid-pairs">
            {RESOURCES.map(({ icon: Icon, title, body }) => (
              <article key={title} data-motion-reveal>
                <Icon size={25} strokeWidth={1.5} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <SharedMemoryFlow />
        </section>

        <section
          id="life-admin"
          className="wh-landing-section wh-landing-controls"
          aria-labelledby="life-admin-title"
        >
          <div className="wh-landing-life-intro">
            <div className="wh-landing-section-intro" data-motion-reveal>
              <p className="wh-landing-eyebrow">Life admin</p>
              <h2 id="life-admin-title">
                Renewals and bookings.
                <br />
                Kept up to date for you.
              </h2>
              <p>
                Ask your agent to go through your email. It saves your rego, insurance,
                bills, subscriptions and bookings to Life admin for you to check, and
                Warthog reminds you before anything’s due.
              </p>
            </div>
            <LifeAdminPreview />
          </div>
          <div className="wh-landing-control-list">
            {LIFE_ADMIN.map(({ icon: Icon, title, body }) => (
              <article key={title} data-motion-reveal>
                <span className="wh-landing-icon">
                  <Icon size={21} aria-hidden="true" />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </article>
            ))}
          </div>
          <p className="wh-landing-scope">
            <MailSearch size={16} aria-hidden="true" /> Warthog doesn’t read your email
            itself. Your agent does, through Warthog, when you ask and only where
            you’ve allowed it.
          </p>
        </section>

        <section
          id="how-it-works"
          className="wh-landing-section"
          aria-labelledby="steps-title"
        >
          <div className="wh-landing-section-intro" data-motion-reveal>
            <p className="wh-landing-eyebrow">How it works</p>
            <h2 id="steps-title">
              Start with one connection.
              <br />
              Make it your own.
            </h2>
          </div>
          <ol className="wh-landing-steps">
            {STEPS.map(({ icon: Icon, title, body }, index) => (
              <li key={title} data-motion-reveal>
                <div className="wh-landing-step-top">
                  <span>0{index + 1}</span>
                  <Icon size={20} aria-hidden="true" />
                </div>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          id="questions"
          className="wh-landing-section wh-landing-faq"
          aria-labelledby="faq-title"
        >
          <div className="wh-landing-section-intro" data-motion-reveal>
            <p className="wh-landing-eyebrow">A few useful answers</p>
            <h2 id="faq-title">Before you settle in.</h2>
            <p>Get to know your agent home, and how it keeps your information safe.</p>
            <div className="wh-landing-intro-links">
              <a href="/help/compatibility" className="wh-landing-link">
                Read the connection guide{" "}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
              <a href="/privacy" className="wh-landing-link">
                Read the privacy policy{" "}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          </div>
          <div className="wh-landing-questions">
            {FAQ_GROUPS.map(({ id, title, items }) => (
              <section key={id} id={id} aria-labelledby={`${id}-title`}>
                <h3 id={`${id}-title`} className="wh-landing-eyebrow">
                  {title}
                </h3>
                {items.map(({ question, answer }) => (
                  <details key={question}>
                    <summary>
                      {question}
                      <ChevronDown size={18} aria-hidden="true" />
                    </summary>
                    <div className="wh-landing-answer">
                      <p>{answer}</p>
                    </div>
                  </details>
                ))}
              </section>
            ))}
          </div>
        </section>

        <section className="wh-landing-closing" aria-labelledby="closing-title" data-motion-surface>
          <LandingBackdrop />
          <div data-motion-reveal>
            <p className="wh-landing-eyebrow">Make yourself at home</p>
            <h2 id="closing-title">
              A little more help.
              <br />A lot more say.
            </h2>
            <p>Your agents, brought together on your terms.</p>
          </div>
          <a href={`${links.account}/signup`} className="wh-landing-button">
            Sign up for Warthog <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
      </main>
      <footer className="wh-landing-footer">
        <div>
          <Wordmark href={links.home} />
          <p>A home for your agents. Control for you.</p>
        </div>
        <nav aria-label="Support">
          <a href="/help/compatibility" className="wh-landing-link">
            Help & compatibility
          </a>
          <a href={`${links.account}/signin`} className="wh-landing-link">
            Sign in
          </a>
        </nav>
        <PolicyLinks />
      </footer>
    </LandingMotion>
  );
}
