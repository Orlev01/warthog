import * as React from "react";
import { ArrowLeft, Bot, Check, Fingerprint, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";

import { Wordmark } from "../shell/wordmark";

const SETUP_STEPS = ["Your details", "Verify email", "Sign-in method", "Recovery"];

// Shared presentation only. Authentication state and sensitive steps remain in
// the existing flow controllers; leaving via Home never submits a form.
export function AuthScreen({ title, lead, children, stage, icon: Icon = Fingerprint }: {
  title: string;
  lead?: string;
  children: React.ReactNode;
  stage?: 1 | 2 | 3 | 4;
  icon?: LucideIcon;
}) {
  return (
    <main className="wh-auth" id="auth-content">
      <header className="wh-auth-header">
        <Wordmark href="/" />
        <a href="/" className="wh-auth-home">
          <ArrowLeft size={16} aria-hidden="true" /> Back to home
        </a>
      </header>
      <div className="wh-auth-layout">
        <section className="wh-auth-panel" aria-labelledby="auth-title">
          {stage ? (
            <div className="wh-auth-progress">
              <p>Step {stage} of 4 <span>· {SETUP_STEPS[stage - 1]}</span></p>
              <ol aria-label="Account setup">
                {SETUP_STEPS.map((label, index) => (
                  <li key={label} aria-current={index + 1 === stage ? "step" : undefined} data-complete={index + 1 < stage || undefined}>
                    <span className="sr-only">{label}{index + 1 < stage ? ": complete" : ""}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <div className="wh-auth-intro">
            <span className="wh-auth-mark"><Icon size={23} strokeWidth={1.5} aria-hidden="true" /></span>
            <h1 id="auth-title">{title}</h1>
            {lead ? <p>{lead}</p> : null}
          </div>
          <div className="wh-auth-body">{children}</div>
        </section>
        <aside className="wh-auth-story" aria-label="About Warthog">
          <p className="wh-landing-eyebrow">A home for your AI agents</p>
          <h2>Your agents.<br /><span>Your rules.</span></h2>
          <p className="wh-auth-story-lead">A personal workspace for the agents you use and the information you choose to share.</p>
          <ul>
            <li><Bot size={20} aria-hidden="true" /><div><strong>Bring your agents together</strong><p>Give each compatible agent its own connection.</p></div></li>
            <li><SlidersHorizontal size={20} aria-hidden="true" /><div><strong>Choose what each can access</strong><p>Share the resources it needs for the job.</p></div></li>
            <li><ShieldCheck size={20} aria-hidden="true" /><div><strong>Keep the decisions yours</strong><p>Set approval rules and review activity in one place.</p></div></li>
          </ul>
          <p className="wh-auth-scope"><Check size={16} aria-hidden="true" /> Your controls apply to requests through Warthog.</p>
        </aside>
      </div>
    </main>
  );
}
