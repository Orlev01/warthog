import * as React from "react";
import { ArrowRight } from "lucide-react";

import { PublicPage, PublicPanel, PublicSection } from "@/components/public/public-page";
import { SUPPORT_EMAIL } from "@/components/public/operator";
import { publicLinksFromEnv } from "@/server/config";
import { publicPageMetadata } from "@/app/site-metadata";

// E18-S16 — Help page entry (`/help`). A PUBLIC page, reachable by anyone with NO
// authentication: it sits at the top level, under no guard layout, because a person
// locked out of their account still needs help. It explains, in plain Australian
// English, what Warthog does, how to connect an agent (linking /help/compatibility),
// how approvals and "Ask me first" work, the two ways back into an account (linking
// /recover and /reset) and the privacy summary (linking /privacy).
//
// The screen is static — it needs no session — so the entry mounts it directly, inside the
// shared public document frame. Its one configured input is where the brand and the
// account links (sign-in, recover, reset) point when the website has its own host
// (docs/adr/website-root-domain.md). No protocol or security jargon
// reaches this primary screen (brief design_ux.copy): no "OAuth", "MCP", "DCR" or
// "token" in the copy. The copy matches the landing's scope statement: Warthog's
// controls apply to requests made through Warthog.

function Action({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="wh-public-action">
      {children} <ArrowRight size={16} aria-hidden="true" />
    </a>
  );
}

export function generateMetadata() {
  return publicPageMetadata("/help");
}

export default function HelpPage() {
  const links = publicLinksFromEnv();
  return (
    <PublicPage
      links={links}
      title="Help"
      current="help"
      lead="The basics of Warthog in plain words. You can read this page even when you’re locked out of your account."
    >
      <PublicPanel>
        <PublicSection id="what-warthog-does" title="What Warthog does">
          <p>
            Warthog is where you manage what each compatible agent can do through its Warthog
            connection: which of your services and information it can use, what needs your
            approval first, and a record of the requests it makes through Warthog. It doesn’t
            control an agent’s own tools, chats or spending outside Warthog.
          </p>
        </PublicSection>

        <PublicSection id="connecting" title="Connecting an agent">
          <p>
            Each agent connects to Warthog with its own connection, so you can change or remove
            its access without touching your other agents. When it uses a service you’ve
            connected, it goes through Warthog and the permissions you chose. Warthog doesn’t
            give it your passwords.
          </p>
          <div className="wh-public-actions">
            <Action href="/help/compatibility">See how to connect your agent</Action>
          </div>
        </PublicSection>

        <PublicSection id="approvals" title="Approvals and “Ask me first”">
          <p>
            When an agent asks for something that needs your say, such as a protected detail,
            your card for a purchase or a change you’ve asked to check, Warthog holds the request
            in your Inbox until you approve or deny it.
          </p>
          <p>
            Set a rule to “Ask me first” for anything you always want to check. Warthog holds the
            request until you decide.
          </p>
          <p>
            A request waits 15 minutes for your answer unless you change the approval expiry in
            Rules &amp; budgets, to anything from 2 minutes to 24 hours. If you don’t decide in
            time, the request expires and is denied, and the agent is told.
          </p>
        </PublicSection>

        <PublicSection id="what-agents-see" title="What agents see in your email">
          <p>
            Agents get a clean, readable copy of each email, without tracking images and with
            hidden text removed where Warthog can spot it. Sign-in codes, password reset links
            and card numbers are kept out. When a sign-in or password email arrives, your agent
            just tells you it’s there and links you to it.
          </p>
          <p>
            That’s the Standard setting. In Settings › Agent defaults you can choose Private, which
            also hides tax file, Medicare, passport, licence, BSB and account numbers, or
            Everything, which shows your emails and files as written.
          </p>
          <p>
            When an agent wants to send an email, the approval shows exactly what will go out and
            whether you’ve emailed that address before. If the agent has just read an email from
            someone else, the approval says so.
          </p>
          <p>
            What Warthog can’t do: it recognises common patterns, not every email, and can’t tell
            a scam from a real request. It only covers what agents do through Warthog, not mail
            connected to an agent directly or the agent’s own web browsing. And once an agent has
            read something, Warthog can’t make it forget it.
          </p>
        </PublicSection>

        <PublicSection id="recovering" title="Getting back into your account">
          <p>
            Lost your passkey? Sign in with your email and the recovery code you saved when you
            signed up. Recovering removes your old passkeys and authenticator app and signs out every
            other device. Your agents stay connected, so check them afterwards.
          </p>
          <div className="wh-public-actions">
            <Action href={`${links.account}/recover`}>Recover your account</Action>
          </div>
          <p>
            Lost your recovery code too? You can reset your account by email. A reset takes 7
            days, erases your saved cards and protected details, and disconnects your agents and
            services. Everything else is kept. Once it finishes, you have 7 days to set up a new
            passkey.
          </p>
          <div className="wh-public-actions">
            <Action href={`${links.account}/reset`}>Reset your account</Action>
          </div>
        </PublicSection>

        <PublicSection id="contact" title="Contact us">
          <p>
            Signed in? Use Contact us in Warthog to ask a question, tell us about a problem or make
            a privacy request, and see what you&apos;ve sent. We reply by email. Can&apos;t sign in?
            Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </p>
          <div className="wh-public-actions">
            <Action href={`${links.account}/contact`}>Contact us</Action>
          </div>
        </PublicSection>

        <PublicSection id="privacy" title="Your privacy">
          <p>
            Your details, your cards and the record of what your agents do are yours. You can
            export everything or delete your account yourself in Settings. The privacy policy
            explains what we store, where it’s kept and who can read it.
          </p>
          <div className="wh-public-actions">
            <Action href="/privacy">Read the privacy policy</Action>
          </div>
        </PublicSection>
      </PublicPanel>
    </PublicPage>
  );
}
