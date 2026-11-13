import * as React from "react";
import type { Metadata } from "next";

import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";

export const metadata: Metadata = { title: "Overview" };

// PLACEHOLDER Overview: the UI slice wires the real dashboard (docs/design/admin-portal.md §5).
export default function AdminOverviewPage() {
  return (
    <div className="wh-page">
      <WorkspaceHeading title="Overview" description="How Warthog is being used and where it needs attention." scope={false} />
    </div>
  );
}
