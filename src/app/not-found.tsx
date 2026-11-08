import * as React from "react";
import type { Metadata } from "next";

import { NotFoundScreen } from "@/components/shell/status-screens";

// The app-wide 404 page (review fix G7): plain words and a way back Home.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return <NotFoundScreen />;
}
