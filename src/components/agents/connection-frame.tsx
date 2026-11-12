import * as React from "react";
import { ArrowLeft, Link2Off } from "lucide-react";
import { Wordmark } from "@/components/shell/wordmark";

export function ConnectionFrame({ children }: { children: React.ReactNode }) {
  return <main className="wh-connection-page" id="connection-content">
    <header className="wh-connection-header"><Wordmark href="/" /><a href="/agents"><ArrowLeft size={16} aria-hidden="true" /> Back to agents</a></header>
    {children}
  </main>;
}

export function ExpiredConnection() {
  return <ConnectionFrame><section className="wh-connection-expired">
    <span className="wh-connection-mark"><Link2Off size={24} aria-hidden="true" /></span>
    <p className="wh-connection-eyebrow">Connection request unavailable</p>
    <h1>Start a fresh connection</h1>
    <p>This request has expired or has already been used. It can’t be approved again from this page.</p>
    <ol><li>Return to the agent or platform you’re connecting.</li><li>Start its Warthog connection again to open a fresh request.</li><li>Review the permissions here before approving.</li></ol>
    <p>If you already approved it, check your agent list before starting again.</p>
    <div className="wh-connection-actions"><a href="/agents" className="wh-connection-link-primary">View your agents</a><a href="/agents/connect">Connection setup guide</a></div>
  </section></ConnectionFrame>;
}
