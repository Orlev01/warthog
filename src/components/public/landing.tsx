import * as React from "react";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  Fingerprint,
  Link2,
  ListChecks,
  LockKeyhole,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { Wordmark } from "../shell/wordmark";
import { PolicyLinks } from "./policy-links";
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

const CONTROLS = [
  {
    icon: SlidersHorizontal,
    title: "The right access for each agent",
    body: "Choose the resources and actions each agent can use. Give your research assistant different permissions from your personal organiser.",
  },
  {
    icon: ShieldCheck,
    title: "Your say before the next step",
    body: "Set approval rules and spending limits for requests through Warthog. Review sensitive requests before they go ahead.",
  },
  {
    icon: ListChecks,
    title: "A clearer picture of what happened",
    body: "See requests, decisions and outcomes together. Change permissions or disconnect an agent when its job is done.",
  },
] as const;

const RESOURCES = [
  {
    icon: BookOpen,
    title: "Memory & skills",
    body: "Keep useful context and reusable instructions in one place. Decide which agents can use them.",
  },
  {
    icon: LockKeyhole,
    title: "A personal vault",
    body: "Store private details with access controls and approval for sensitive information.",
  },
  {
    icon: FileText,
    title: "Everyday life admin",
    body: "Keep receipts, reminders and household records organised, alongside the agents you choose to help.",
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

export function Landing() {
  return (
    <LandingMotion>
      <a className="wh-landing-skip" href="#main-content">
        Skip to content
      </a>
      {/* The brand and account links form the pinned top bar. The section links follow it:
          a strip that scrolls away on phones, drawn inside the sticky bar from 768px
          (public.css), so the bar stays about 64px tall everywhere (mobile-14). */}
      <header className="wh-landing-header">
        <Wordmark href="/" />
        <div className="wh-landing-account">
          <a href="/signin" className="wh-landing-link">
            Sign in
          </a>
          <a
            href="/signup"
            className="wh-landing-button wh-landing-header-signup"
          >
            Sign up <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </header>
      <nav aria-label="Explore Warthog" className="wh-landing-nav">
        <a href="#your-control">Control</a>
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
              <a href="/signup" className="wh-landing-button">
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
          <p className="wh-landing-scope">
            <CircleHelp size={16} aria-hidden="true" /> These controls apply
            only to requests made through Warthog. Activity through an agent’s
            other tools stays with that provider.
          </p>
        </section>

        <section
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
          <div className="wh-landing-resource-grid">
            {RESOURCES.map(({ icon: Icon, title, body }) => (
              <article key={title} data-motion-reveal>
                <Icon size={25} strokeWidth={1.5} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
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
            <p>Get to know your agent home.</p>
            <a href="/help/compatibility" className="wh-landing-link">
              Read the connection guide{" "}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
          <div className="wh-landing-questions">
            {FAQS.map(({ question, answer }) => (
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
          <a href="/signup" className="wh-landing-button">
            Sign up for Warthog <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
      </main>
      <footer className="wh-landing-footer">
        <div>
          <Wordmark href="/" />
          <p>A home for your agents. Control for you.</p>
        </div>
        <nav aria-label="Support">
          <a href="/help/compatibility" className="wh-landing-link">
            Help & compatibility
          </a>
          <a href="/signin" className="wh-landing-link">
            Sign in
          </a>
        </nav>
        <PolicyLinks />
      </footer>
    </LandingMotion>
  );
}
