import * as React from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Landing } from "@/components/public/landing";
import { requestHostname } from "@/server/admin/origin";
import { redirectSignedInVisitor } from "@/server/auth/public-entry";
import { onWebsiteHost, publicLinksFromEnv, websiteFromEnv } from "@/server/config";
import { publicPageMetadata } from "./site-metadata";

const FRONT_DOOR: Metadata = {
  // The front door names the product in the tab and history (public-19).
  title: { absolute: "Warthog — Your agents. Your rules." },
  description: "A home for your AI agents. Bring your services and information together, choose each agent’s access, and review requests on your terms.",
  openGraph: {
    title: "Warthog — Your agents. Your rules.",
    description: "Bring your services, information and agents together. Decide what each agent can access, what it can do, and when it needs to ask.",
    type: "website",
  },
};

export function generateMetadata(): Metadata {
  return publicPageMetadata("/", FRONT_DOOR);
}

// The website host always shows the front door, signed in or not, and never opens the
// database (docs/adr/website-root-domain.md). On the app host, returning members enter their
// workspace; signed-out visitors go to sign-in when the front door has its own host, and see
// it here otherwise. This stays outside the protected route group.
export default async function Home() {
  if (onWebsiteHost(requestHostname(await headers()))) {
    return <Landing links={publicLinksFromEnv()} />;
  }
  await redirectSignedInVisitor();
  if (websiteFromEnv()) redirect("/signin");
  return <Landing />;
}
