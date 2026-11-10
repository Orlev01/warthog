import * as React from "react";
import { AlertTriangle, Compass, Home, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// The app's fallback screens (review fix G7): the body of the error boundaries
// (src/app/error.tsx, src/app/global-error.tsx), the 404 page (src/app/not-found.tsx) and
// the route loading state (src/app/(portal)/(protected)/loading.tsx). Each is calm, plain Australian English,
// built on the design tokens, and always offers a way back into the app. An error's raw
// message is never shown (it can carry internal detail); only Next's opaque digest is,
// as a reference for support.

const LINK_CLASS =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

function ScreenFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[60dvh] w-full max-w-lg flex-col items-start justify-center gap-4 px-4 py-12 sm:px-6">
      {children}
    </main>
  );
}

function HomeLink() {
  return (
    <a href="/home" className={LINK_CLASS}>
      <Home aria-hidden={true} className="h-4 w-4 shrink-0" />
      Go to Home
    </a>
  );
}

export type ErrorScreenProps = {
  // Next's opaque error reference (never the message), shown for support.
  digest?: string;
  // Re-render the segment (error.tsx); absent for the root global error.
  reset?: () => void;
};

export function ErrorScreen({ digest, reset }: ErrorScreenProps) {
  return (
    <ScreenFrame>
      <AlertTriangle aria-hidden={true} className="h-8 w-8 text-danger" />
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Something went wrong</h1>
      <p className="text-sm text-fg-muted">
        Warthog couldn&apos;t show this page just now. Nothing you were doing has been
        changed. Try again, or head back Home.
      </p>
      {digest ? <p className="text-xs text-fg-muted">Reference: {digest}</p> : null}
      <div className="flex flex-wrap gap-3">
        {reset ? (
          <Button type="button" variant="primary" onClick={reset}>
            <RotateCcw aria-hidden={true} className="h-4 w-4 shrink-0" />
            Try again
          </Button>
        ) : null}
        <HomeLink />
      </div>
    </ScreenFrame>
  );
}

export function NotFoundScreen() {
  return (
    <ScreenFrame>
      <Compass aria-hidden={true} className="h-8 w-8 text-fg-muted" />
      <h1 className="text-2xl font-semibold tracking-tight text-fg">We couldn&apos;t find that page</h1>
      <p className="text-sm text-fg-muted">
        The link may be old, or the page may have moved. Everything else is where you left it.
      </p>
      <HomeLink />
    </ScreenFrame>
  );
}

export function LoadingScreen() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-48">
        <span className="sr-only">Loading…</span>
      </Skeleton>
      <div aria-hidden={true} className="flex flex-col gap-3">
        <div className="h-20 animate-pulse rounded-card bg-surface-muted" />
        <div className="h-20 animate-pulse rounded-card bg-surface-muted" />
      </div>
    </div>
  );
}
