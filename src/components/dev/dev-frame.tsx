import * as React from "react";

import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { ButtonLink } from "@/components/ui/button-link";

// The frame both dev pages share (local builds only, behind the dev-tools guard). They sit
// outside the signed-in shell, so this gives them the workspace canvas and surfaces, the
// reading measure, a heading band with a way back to Home and to the other dev page, and no
// text loose on the background (founder rule 1; containment-15, desktop-20).

const DEV_PAGES = [
  { href: "/dev/agent-console", label: "Agent console" },
  { href: "/dev/outbox", label: "Dev outbox" },
] as const;

export function DevFrame({
  current,
  title,
  description,
  children,
}: {
  current: (typeof DEV_PAGES)[number]["href"];
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  const other = DEV_PAGES.find((page) => page.href !== current)!;
  return (
    <div className="wh-workspace">
      <main className="wh-main" data-measure="reading" id="dev-content">
        <div className="wh-page">
          <WorkspaceHeading eyebrow="Dev tools" title={title} description={description} scope={false}>
            <ButtonLink href="/home">Go to Home</ButtonLink>
            <ButtonLink href={other.href}>{other.label}</ButtonLink>
          </WorkspaceHeading>
          {children}
        </div>
      </main>
    </div>
  );
}

export default DevFrame;
