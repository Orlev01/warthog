import * as React from "react";
import { Terms } from "@/components/public/terms";
import { publicLinksFromEnv } from "@/server/config";
import { publicPageMetadata } from "@/app/site-metadata";

// Named after the page heading.
export function generateMetadata() {
  return publicPageMetadata("/terms", { title: "Terms of use" });
}

export default function TermsPage() {
  return <Terms links={publicLinksFromEnv()} />;
}
