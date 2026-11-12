import * as React from "react";
import { ArrowLeft, Link2Off } from "lucide-react";
import { Wordmark } from "@/components/shell/wordmark";

// The focused frame for an agent connection outside the workspace shell: a full-width brand
// bar (the page's banner, outside <main>) and the flow's panels on the public canvas, on an
// 880px measure (640px for a single-panel state). Styling: src/app/public.css.
export function ConnectionFrame({ children, narrow = false }: { children: React.ReactNode; narrow?: boolean }) {
  return <div className={narrow ? "wh-connection-page wh-connection-page--narrow" : "wh-connection-page"}>
    <header className="wh-connection-header wh-public-bar">
      <div className="wh-public-bar-inner">
        <Wordmark href="/" />
        <a href="/agents" className="wh-public-back"><ArrowLeft size={16} aria-hidden="true" /> Back to agents</a>
      </div>
    </header>
    <main className="wh-connection-main" id="connection-content">{children}</main>
  </div>;
}

// An expired or already-used request: one panel that says what happened, how to start
// again, and where to go (content-49).
export function ExpiredConnection() {
  return <ConnectionFrame narrow><section className="wh-connection-expired" aria-labelledby="connection-expired-title">
    <span className="wh-connection-mark"><Link2Off size={24} aria-hidden="true" /></span>
    <p className="wh-connection-eyebrow">Connect an agent</p>
    <h1 id="connection-expired-title">This connection request has expired</h1>
    <p>It may have timed out or already been used, so it can’t be approved here.</p>
    <ol><li>Return to the agent or platform you’re connecting.</li><li>Start its Warthog connection again to open a fresh request.</li><li>Review the permissions here before approving.</li></ol>
    <p>Already approved it? Check your agents before starting again.</p>
    <div className="wh-connection-actions"><a href="/agents" className="wh-connection-link-primary">View your agents</a><a href="/agents/connect" className="wh-connection-link">Connection setup guide</a></div>
  </section></ConnectionFrame>;
}
