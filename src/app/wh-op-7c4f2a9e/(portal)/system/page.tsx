import * as React from "react";
import type { Metadata } from "next";

import { SystemView } from "@/components/admin/system-view";
import { AdminPageError } from "@/components/admin/view-common";
import { getAdminPageDeps } from "@/server/admin/compose";
import { requireAdminPage } from "@/server/admin/page-guard";
import { loadSystem } from "@/server/admin/page-data";

// The System page of the admin portal (docs/design/admin-portal.md §5): a thin loader that
// reads the query, composes the admin seams, calls the tested loader and renders the view. A
// failed read shows a bounded error state rather than a stack trace. Dynamic by construction
// (the request's query is read first), never prerendered.

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  await requireAdminPage();
  try {
    const deps = await getAdminPageDeps();
    void params;
    const model = await loadSystem(deps);
    return <SystemView model={model} now={deps.clock.now()} />;
  } catch (error) {
    console.error("[warthog admin]", JSON.stringify({ level: "error", where: "system", error: error instanceof Error ? error.name : "unknown" }));
    return <AdminPageError title="System" description="The release that is running and its background work." />;
  }
}
