import * as React from "react";
import type { Metadata } from "next";

import { ReliabilityView } from "@/components/admin/reliability-view";
import { AdminPageError } from "@/components/admin/view-common";
import { getAdminPageDeps } from "@/server/admin/compose";
import { loadReliability } from "@/server/admin/page-data";
import { parseRange } from "@/domain/admin/range";

// The Reliability page of the admin portal (docs/design/admin-portal.md §5): a thin loader that
// reads the query, composes the admin seams, calls the tested loader and renders the view. A
// failed read shows a bounded error state rather than a stack trace. Dynamic by construction
// (the request's query is read first), never prerendered.

export const metadata: Metadata = { title: "Reliability" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  try {
    const deps = await getAdminPageDeps();
    const model = await loadReliability(deps, parseRange(params.range));
    return <ReliabilityView model={model} now={deps.clock.now()} />;
  } catch (error) {
    console.error("[warthog admin]", JSON.stringify({ level: "error", where: "reliability", error: error instanceof Error ? error.name : "unknown" }));
    return <AdminPageError title="Reliability" description="Where things fail." />;
  }
}
