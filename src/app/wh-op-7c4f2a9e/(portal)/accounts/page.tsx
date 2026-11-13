import * as React from "react";
import type { Metadata } from "next";

import { AccountsView } from "@/components/admin/accounts-view";
import { AdminPageError } from "@/components/admin/view-common";
import { getAdminPageDeps } from "@/server/admin/compose";
import { loadAccounts } from "@/server/admin/page-data";

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? value[0] ?? null : value ?? null);

// The Accounts page of the admin portal (docs/design/admin-portal.md §5): a thin loader that
// reads the query, composes the admin seams, calls the tested loader and renders the view. A
// failed read shows a bounded error state rather than a stack trace. Dynamic by construction
// (the request's query is read first), never prerendered.

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  try {
    const deps = await getAdminPageDeps();
    const model = await loadAccounts(deps, { email: first(params.email), filter: first(params.filter) });
    return <AccountsView model={model} now={deps.clock.now()} />;
  } catch (error) {
    console.error("[warthog admin]", JSON.stringify({ level: "error", where: "accounts", error: error instanceof Error ? error.name : "unknown" }));
    return <AdminPageError title="Accounts" description="How each account is going." />;
  }
}
