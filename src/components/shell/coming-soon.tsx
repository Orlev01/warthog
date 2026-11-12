import * as React from "react";
import { EmptyState } from "@/components/ui/empty";
import { WorkspaceHeading } from "./workspace-surfaces";

// ComingSoon — operator scaffolding. Every route the navigation or a redirect points at exists
// from day one, so links never dead-end (and the route lint stays green) while the real screens
// are still being built. Each placeholder page names the backlog task that replaces it.
export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="wh-page">
      <WorkspaceHeading title={title} />
      <EmptyState
        heading="On its way"
        description="This part of Warthog is still being built. Check back soon."
      />
    </div>
  );
}
