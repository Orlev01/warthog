import * as React from "react";
import type { Metadata } from "next";

import { RequestsView } from "@/components/admin/requests-view";
import { AdminPageError } from "@/components/admin/view-common";
import { getAdminPageDeps } from "@/server/admin/compose";
import { requireAdminPage } from "@/server/admin/page-guard";
import { loadRequests } from "@/server/admin/page-data";

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? value[0] ?? null : value ?? null);

// The Requests page of the admin portal (docs/adr/admin-portal.md, amendment of 20 November
// 2026): a thin loader that reads the query, composes the admin seams, calls the tested loader
// and renders the view. A failed read shows a bounded error state rather than a stack trace.

export const metadata: Metadata = { title: "Requests" };
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
    const model = await loadRequests(deps, { filter: first(params.filter), notice: first(params.notice) });
    return <RequestsView model={model} now={deps.clock.now()} />;
  } catch (error) {
    console.error("[warthog admin]", JSON.stringify({ level: "error", where: "requests", error: error instanceof Error ? error.name : "unknown" }));
    return <AdminPageError title="Requests" description="What people have asked you for." />;
  }
}
