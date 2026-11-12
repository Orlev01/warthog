"use client";
import * as React from "react";
import { ResourceScope, type ScopeAgent } from "@/components/agents/resource-scope";

// What the signed-in chrome knows about the current page, shared with the page's own
// primitives without prop drilling: the live path and the member's agents (both already loaded
// by the (protected) layout for PortalChrome). Outside PortalChrome — render tests, public
// pages — there is no provider and consumers render nothing extra.
export type WorkspaceContextValue = {
  pathname: string;
  agents: readonly ScopeAgent[];
};
export const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

// The agent-scope row inside WorkspaceHeading on resource pages (Connectors, Vault, Skills,
// Memory, Spending, Rules). Renders nothing elsewhere or outside the workspace.
export function HeadingScope() {
  const workspace = React.useContext(WorkspaceContext);
  if (!workspace) return null;
  return <ResourceScope variant="heading" pathname={workspace.pathname} agents={workspace.agents} />;
}
