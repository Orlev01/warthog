import * as React from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Landing } from "@/components/public/landing";
import { requestHostname } from "@/server/admin/origin";
import { redirectSignedInVisitor } from "@/server/auth/public-entry";
import { websiteFromEnv } from "@/server/config";
import { publicLinksFor } from "@/server/http/website";

export const metadata: Metadata = {
  // The front door names the product in the tab and history (public-19).
  title: { absolute: "Warthog — Your agents. Your rules." },
  description: "A home for your AI agents. Bring your services and information together, choose each agent’s access, and review requests on your terms.",
  openGraph: {
    title: "Warthog — Your agents. Your rules.",
    description: "Bring your services, information and agents together. Decide what each agent can access, what it can do, and when it needs to ask.",
    type: "website",
  },
};

// The website host always shows the front door, signed in or not, and never opens the
// database (docs/adr/website-root-domain.md). On the app host, returning members enter their
// workspace; signed-out visitors go to sign-in when the front door has its own host, and see
// it here otherwise. This stays outside the protected route group.
export default async function Home() {
  const website = websiteFromEnv();
  if (website && requestHostname(await headers()) === website.host) {
    return <Landing links={publicLinksFor(website)} />;
  }
  await redirectSignedInVisitor();
  if (website) redirect("/signin");
  return <Landing />;
}
