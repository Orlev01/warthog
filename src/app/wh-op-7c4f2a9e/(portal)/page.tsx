import * as React from "react";
import type { Metadata } from "next";

import { OverviewView } from "@/components/admin/overview-view";
import { AdminPageError } from "@/components/admin/view-common";
import { getAdminPageDeps } from "@/server/admin/compose";
import { requireAdminPage } from "@/server/admin/page-guard";
import { loadOverview } from "@/server/admin/page-data";
import { parseRange } from "@/domain/admin/range";

// The Overview page of the admin portal (docs/design/admin-portal.md §5): a thin loader that
// reads the query, composes the admin seams, calls the tested loader and renders the view. A
// failed read shows a bounded error state rather than a stack trace. Dynamic by construction
// (the request's query is read first), never prerendered.

export const metadata: Metadata = { title: "Overview" };
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
    const model = await loadOverview(deps, parseRange(params.range));
    return <OverviewView model={model} />;
  } catch (error) {
    console.error("[warthog admin]", JSON.stringify({ level: "error", where: "overview", error: error instanceof Error ? error.name : "unknown" }));
    return <AdminPageError title="Overview" description="How Warthog is being used and where it needs attention." />;
  }
}
