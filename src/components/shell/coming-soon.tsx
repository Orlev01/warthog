import * as React from "react";
import { EmptyState } from "@/components/ui/empty";

// ComingSoon — operator scaffolding. Every route the navigation or a redirect points at exists
// from day one, so links never dead-end (and the route lint stays green) while the real screens
// are still being built. Each placeholder page names the backlog task that replaces it.
export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      <EmptyState
        heading="On its way"
        description="This part of Warthog is still being built. Check back soon."
      />
    </div>
  );
}
