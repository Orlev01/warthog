import * as React from "react";
import { ArrowRight } from "lucide-react";

import { PublicPage, PublicPanel, PublicSection } from "@/components/public/public-page";

// E18-S16 — Help page entry (`/help`). A PUBLIC page, reachable by anyone with NO
// authentication: it sits at the top level, under no guard layout, because a person
// locked out of their account still needs help. It explains, in plain Australian
// English, what Warthog does, how to connect an agent (linking /help/compatibility),
// how approvals and "Ask me first" work, the two ways back into an account (linking
// /recover and /reset) and the privacy summary (linking /privacy).
//
// The screen is static — it needs no session and no config — so the entry mounts it
// directly, inside the shared public document frame. No protocol or security jargon
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

export default function HelpPage() {
  return (
    <PublicPage
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

        <PublicSection id="recovering" title="Getting back into your account">
          <p>
            Lost your passkey? Sign in with your email and the recovery code you saved when you
            signed up.
          </p>
          <div className="wh-public-actions">
            <Action href="/recover">Recover your account</Action>
          </div>
          <p>
            Lost your recovery code too? You can reset your account by email. A reset takes 7
            days, erases your saved cards and protected details, and disconnects your agents and
            services. Everything else is kept.
          </p>
          <div className="wh-public-actions">
            <Action href="/reset">Reset your account</Action>
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
