import * as React from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getServerDb } from "@/server/db/server";
import { LifeAdminItemView } from "@/components/life-admin/item-view";
import { firstParam } from "@/lib/href";
import { itemPath, journalInput, noticeField } from "../../form-inputs";
import { OutcomeNotice, toNotice, type Notice } from "../../notices";
import { buildActions, resolveSession, run } from "../../wiring";

// A Life admin item's own page (docs/adr/life-admin-journal.md): the thin protected-page
// loader + action wiring over the tested `createLifeAdminActions` seam (`loadItem`,
// `addJournalEntry`, `markNextDone`, `setSteward`). The id in the address is validated as a uuid
// and read member-scoped by the seam, so another person's item (or anything that isn't an
// item) shows "Item not found", never someone else's data. Each wrapper re-derives the
// verified session, takes its input from the submitted form and redirects back to this item
// with a `?notice=` in plain words; a refusal (text that looks like an identifier Warthog
// never keeps) names the place, never the text. Per-request data is read before the database,
// so `next build` never prerenders this page.

// Names the screen in the browser tab and to screen readers ("Life admin item · Warthog");
// the item's own name is personal content, so it never goes in the title.
export const metadata: Metadata = { title: "Life admin item" };

function str(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

async function addJournalAction(formData: FormData): Promise<void> {
  "use server";
  const input = journalInput(formData);
  const path = itemPath(input.id);
  await run(
    (result) => ({ notice: result.outcome === "cut" ? "journal_cut" : "journal_added" }),
    (actions, session) => actions.addJournalEntry(session, input),
    path,
    "journal_invalid",
    path,
    { anchor: false, revalidate: [path] },
  );
}

async function markNextDoneAction(formData: FormData): Promise<void> {
  "use server";
  const path = itemPath(str(formData, "recordId"));
  await run("next_done", (actions, session) => actions.markNextDone(session, { id: str(formData, "recordId"), stepId: str(formData, "stepId") }),
    path, "problem", path, { anchor: false, revalidate: [path] });
}

const STEWARD_NOTICES: Readonly<Record<string, Notice>> = { assigned: "steward_set", unassigned: "steward_cleared" };

async function setStewardAction(formData: FormData): Promise<void> {
  "use server";
  const path = itemPath(str(formData, "recordId"));
  await run(
    (result) => ({ notice: STEWARD_NOTICES[result.outcome ?? ""] ?? "updated" }),
    (actions, session) => actions.setSteward(session, { id: str(formData, "recordId"), agentId: str(formData, "agentId") }),
    path,
    "problem",
    path,
    { anchor: false, revalidate: [path] },
  );
}

export default async function LifeAdminItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic.
  const { id } = await params;
  const query = await searchParams;
  const notice = toNotice(query.notice);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const data = await buildActions(db).loadItem(session, id);
  return (
    <div className="wh-page">
      <LifeAdminItemView
        data={data}
        notice={notice ? <OutcomeNotice notice={notice} field={noticeField(firstParam(query.field))} /> : null}
        addJournalAction={addJournalAction}
        markNextDoneAction={markNextDoneAction}
        setStewardAction={setStewardAction}
      />
    </div>
  );
}
