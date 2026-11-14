"use client";

import * as React from "react";
import { ArrowLeft, Bot, Fingerprint, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";

import { Wordmark } from "../shell/wordmark";
import { useWebsiteHome } from "../public/website-home";

const SETUP_STEPS = ["Your details", "Verify email", "Sign-in method", "Recovery"];

// Moves keyboard and screen-reader focus with the flow (a11y-01, WCAG 2.4.3 / 4.1.3). When
// the step's title changes, the new heading takes focus so its name is read; when a new
// error arrives and a field is marked invalid, that field takes focus. The first render
// never moves focus (nor does React's development double-invoke), so loading a page doesn't
// steal it.
function useStepFocus(
  panel: React.RefObject<HTMLElement | null>,
  heading: React.RefObject<HTMLHeadingElement | null>,
  title: string,
  error: string | undefined,
) {
  const shownTitle = React.useRef(title);
  const shownError = React.useRef(error);
  React.useEffect(() => {
    if (shownTitle.current === title) return;
    shownTitle.current = title;
    heading.current?.focus();
  }, [heading, title]);
  React.useEffect(() => {
    if (error === shownError.current) return;
    shownError.current = error;
    if (!error) return;
    panel.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [panel, error]);
}

// Shared presentation only. Authentication state and sensitive steps remain in
// the existing flow controllers; leaving via Home never submits a form. The brand bar is
// the page's banner, outside <main>; the form is always a bounded panel and, from 1024px,
// a quieter introduction panel sits beside it (public.css). The (auth) layout adds the
// footer bar.
export function AuthScreen({ title, lead, children, stage, icon: Icon = Fingerprint, error }: {
  title: string;
  lead?: React.ReactNode;
  children: React.ReactNode;
  stage?: 1 | 2 | 3 | 4;
  icon?: LucideIcon;
  // The step's current error, so focus can follow it to the field it marks invalid.
  error?: string;
}) {
  const panel = React.useRef<HTMLElement>(null);
  const heading = React.useRef<HTMLHeadingElement>(null);
  useStepFocus(panel, heading, title, error);
  const home = useWebsiteHome();
  return (
    <>
      <header className="wh-auth-header wh-public-bar">
        <div className="wh-public-bar-inner">
          <Wordmark href={home} />
          <a href={home} className="wh-public-back">
            <ArrowLeft size={16} aria-hidden="true" /> Back to home
          </a>
        </div>
      </header>
      <main className="wh-auth" id="auth-content">
        <div className="wh-auth-layout">
          <section className="wh-auth-panel" aria-labelledby="auth-title" ref={panel}>
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
              <h1 id="auth-title" ref={heading} tabIndex={-1}>{title}</h1>
              {lead ? <p>{lead}</p> : null}
            </div>
            <div className="wh-auth-body">
              {children}
              <noscript><p className="text-sm text-fg-muted">Turn on JavaScript to continue. Passkeys and sign-in codes need it.</p></noscript>
            </div>
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
          </aside>
        </div>
      </main>
    </>
  );
}
