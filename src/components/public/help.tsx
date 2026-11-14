import { AGENT_PLATFORMS as PLATFORMS } from "@/domain/agents/compatibility";
import * as React from "react";
import { ExternalLink } from "lucide-react";

import { RELATIVE_LINKS, type PublicLinks } from "@/server/http/website";
import { CopyButton } from "../ui/copy-button";
import { PublicPage, PublicPanel, PublicSection } from "./public-page";

// Help — the public "Connect your agents" VIEW (brief feature "Agent compatibility and
// help pages"; "Connect an agent"). From ONE render-testable component it shows, per
// agent platform, how to connect Warthog, where to paste Warthog's connector address,
// and a note of any current platform gap and what to do instead.
//
// The connector address is config-driven (INV-21), so it arrives as a prop — the
// page entry (src/app/help/compatibility/page.tsx) derives it from
// `config.publicBaseUrl` and passes it in; this component stays pure (no config, no
// DB). Everything is said in plain Australian English for members — no protocol,
// security or release-testing vocabulary reaches this screen (brief design_ux.copy;
// content-08). It renders inside the shared public document frame (PublicPage).

// The agent platforms the task/brief name, each with plain connect steps. The steps
// say exactly where to paste the Warthog address shown above them.
export function Help({ connectorAddress, links = RELATIVE_LINKS }: { connectorAddress: string; links?: PublicLinks }) {
  return (
    <PublicPage
      links={links}
      title="Connect your agents"
      current="compatibility"
      lead="Choose your agent below. Each one gets its own connection, so you can set and remove its access separately."
    >
      <PublicPanel>
        <PublicSection id="address" title="Your Warthog address">
          <p>Copy this address and paste it in when your agent asks for a custom connector.</p>
          <div className="wh-public-address">
            <code>{connectorAddress}</code>
            <CopyButton value={connectorAddress} successMessage="Address copied." />
          </div>
        </PublicSection>
      </PublicPanel>

      <PublicPanel>
        <PublicSection id="agents" title="Connect each agent">
          <dl className="wh-public-rows">
            {PLATFORMS.map((platform) => (
              <div key={platform.name}>
                <dt>{platform.name}</dt>
                <dd>{platform.steps.join(" ")}</dd>
                {"docs" in platform ? (
                  <dd>
                    <a href={platform.docs} className="wh-connection-link">
                      {platform.name} setup guide <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  </dd>
                ) : null}
              </div>
            ))}
          </dl>
        </PublicSection>
      </PublicPanel>

      <PublicPanel>
        <PublicSection id="cant-connect" title="If an agent can’t connect yet">
          <p>
            Some apps can’t add a custom connector yet. An access key only helps if the app has a
            place to paste one. Connecting a service such as Slack or Notion as a tool doesn’t
            connect that service’s own agents.
          </p>
        </PublicSection>
        <PublicSection id="what-warthog-sees" title="What Warthog can see">
          <p>
            Warthog sees and controls only the requests an agent sends through Warthog. It never
            sees your chats with the agent, what the agent does with its own tools, or what its
            provider charges you.
          </p>
          <p>
            When a tool doesn’t say exactly what it will do, Warthog applies your rules cautiously.
            Not every action for every service has been tried with a live account yet.
          </p>
        </PublicSection>
      </PublicPanel>
    </PublicPage>
  );
}
