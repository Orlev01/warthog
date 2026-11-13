import * as React from "react";
import { AlertTriangle, Bot, Compass, Home, LifeBuoy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Skeleton } from "@/components/ui/skeleton";
import { PolicyLinks } from "@/components/public/policy-links";
import { Wordmark } from "./wordmark";

// The app's fallback screens (review fix G7): the body of the error boundaries
// (src/app/error.tsx, src/app/global-error.tsx), the 404 pages (src/app/not-found.tsx and,
// inside the signed-in shell, src/app/(portal)/(protected)/not-found.tsx) and the route
// loading state (src/app/(portal)/(protected)/loading.tsx). Each is calm, plain Australian
// English, built on the design tokens, bounded in a panel and always offers a way forward.
// An error's raw message is never shown (it can carry internal detail); only Next's opaque
// digest is, as a reference for support.
//
// Two frames:
//   • `public` — outside the workspace (signed out, or the root boundaries): the panel on the
//     tinted public canvas under a wordmark bar, with the policy links in a footer bar. Its
//     way back is "/", which already sends a signed-in member on to /home.
//   • `workspace` — inside AppShell: the panel in the page container, so the sidebar, top
//     bar and drawer stay put and every destination is one click away.

export type StatusVariant = "public" | "workspace";

function StatusPanel({
  icon,
  title,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="wh-status-panel">
      <span className="wh-status-icon">{icon}</span>
      <h1 id={id} className="wh-standalone-title">
        {title}
      </h1>
      <div className="wh-status-copy">{children}</div>
      <div className="wh-status-actions">{actions}</div>
    </section>
  );
}

function ScreenFrame({ variant, children }: { variant: StatusVariant; children: React.ReactNode }) {
  if (variant === "workspace") return <div className="wh-page wh-status-page-body">{children}</div>;
  return (
    <div className="wh-status-page">
      <header className="wh-status-bar">
        <div className="wh-status-bar-inner">
          <Wordmark href="/" />
        </div>
      </header>
      <main className="wh-status-main">{children}</main>
      <footer className="wh-status-bar wh-status-footer">
        <div className="wh-status-bar-inner">
          <PolicyLinks />
        </div>
      </footer>
    </div>
  );
}

// A generic status screen for a one-off outcome page (the admin portal's signed-out page):
// the same frame and panel the error and not-found screens use, with the caller's icon,
// title, copy and actions.
export function StatusScreen({
  icon,
  title,
  children,
  actions,
  variant = "public",
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  variant?: StatusVariant;
}) {
  return (
    <ScreenFrame variant={variant}>
      <StatusPanel icon={icon} title={title} actions={actions}>
        {children}
      </StatusPanel>
    </ScreenFrame>
  );
}

export type ErrorScreenProps = {
  // Next's opaque error reference (never the message), shown for support.
  digest?: string;
  // Re-render the segment (error.tsx); absent for the root global error.
  reset?: () => void;
  variant?: StatusVariant;
};

export function ErrorScreen({ digest, reset, variant = "public" }: ErrorScreenProps) {
  return (
    <ScreenFrame variant={variant}>
      <StatusPanel
        icon={<AlertTriangle aria-hidden={true} className="h-6 w-6 text-danger" />}
        title="Something went wrong"
        actions={
          <>
            {reset ? (
              <Button type="button" variant="primary" onClick={reset}>
                <RotateCcw aria-hidden={true} className="h-4 w-4 shrink-0" />
                Try again
              </Button>
            ) : null}
            {variant === "workspace" ? (
              <ButtonLink href="/home" variant={reset ? "secondary" : "primary"}>
                <Home aria-hidden={true} className="h-4 w-4 shrink-0" />
                Go to Home
              </ButtonLink>
            ) : (
              <ButtonLink href="/" variant={reset ? "secondary" : "primary"}>
                <Home aria-hidden={true} className="h-4 w-4 shrink-0" />
                Go to Warthog
              </ButtonLink>
            )}
          </>
        }
      >
        <p>
          Warthog couldn&apos;t show this page just now. Nothing you were doing has been
          changed.{" "}
          {variant === "workspace"
            ? "Try again, or head back to Home."
            : "Try again, or go back to the Warthog home page."}
        </p>
        {digest ? <p className="wh-status-reference">Reference for support: {digest}</p> : null}
      </StatusPanel>
    </ScreenFrame>
  );
}

export function NotFoundScreen({ variant = "public" }: { variant?: StatusVariant }) {
  const workspace = variant === "workspace";
  return (
    <ScreenFrame variant={variant}>
      <StatusPanel
        icon={<Compass aria-hidden={true} className="h-6 w-6 text-fg-muted" />}
        title="We couldn't find that page"
        actions={
          workspace ? (
            <>
              <ButtonLink href="/home" variant="primary">
                <Home aria-hidden={true} className="h-4 w-4 shrink-0" />
                Go to Home
              </ButtonLink>
              <ButtonLink href="/agents">
                <Bot aria-hidden={true} className="h-4 w-4 shrink-0" />
                Your agents
              </ButtonLink>
            </>
          ) : (
            <>
              <ButtonLink href="/" variant="primary">
                <Home aria-hidden={true} className="h-4 w-4 shrink-0" />
                Go to Warthog
              </ButtonLink>
              <ButtonLink href="/help">
                <LifeBuoy aria-hidden={true} className="h-4 w-4 shrink-0" />
                Get help
              </ButtonLink>
            </>
          )
        }
      >
        <p>
          {workspace
            ? "The link may be old, or the page may have moved. Everything in your workspace is where you left it."
            : "The link may be old, or the page may have moved."}
        </p>
      </StatusPanel>
    </ScreenFrame>
  );
}

// The loading state inside the workspace: the same page container, heading band and panel
// rhythm the page will have, so content streams in without the layout jumping.
export function LoadingScreen() {
  return (
    <div className="wh-page wh-loading-page">
      <div className="wh-loading-band">
        <Skeleton className="h-7 w-48">
          <span className="sr-only">Loading…</span>
        </Skeleton>
        <div aria-hidden={true} className="mt-3 h-4 w-72 max-w-full animate-pulse rounded-field bg-surface-muted" />
      </div>
      <div aria-hidden={true} className="wh-loading-panel" />
      <div aria-hidden={true} className="wh-loading-panel" />
    </div>
  );
}
