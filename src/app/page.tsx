import * as React from "react";
import type { Metadata } from "next";

import { Landing } from "@/components/public/landing";
import { redirectSignedInVisitor } from "@/server/auth/public-entry";

export const metadata: Metadata = {
  title: "Your agents. Your rules.",
  description: "A home for your AI agents. Bring your services and information together, choose each agent’s access, and review requests on your terms.",
  openGraph: {
    title: "Warthog — Your agents. Your rules.",
    description: "Bring your services, information and agents together. Decide what each agent can access, what it can do, and when it needs to ask.",
    type: "website",
  },
};

// Returning members enter their workspace; signed-out visitors see the public
// front door. This stays outside the protected route group.
export default async function Home() {
  await redirectSignedInVisitor();
  return <Landing />;
}
