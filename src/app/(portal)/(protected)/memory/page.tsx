import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createMemoryActions, type MemoryActions } from "./actions";
import { MemoryView } from "@/components/memory/memory-view";
import { PageContainer } from "@/components/shell/page-container";
import { Notice as InlineNotice } from "@/components/ui/notice";

// E13-S11 — Memory page (the thin protected-page loader + action wiring over the tested
// `createMemoryActions` seam, `./actions`). It reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the
// person's own memories — content decrypted, each source agent resolved to a display
// name, each saved time pre-formatted — and mounts the already-render-tested
// <MemoryView/> with each control BOUND to a `use server` wrapper over the SAME seam:
// Add (addMemory), Edit (editMemory), Change scope (rescopeMemory), Delete (deleteMemory).
// Search is a plain GET the loader reads (`?q=`). Every wrapper re-derives the verified
// session (never trusting a client value for identity), takes its input from the
// submitted form, persists member-scoped through the seam, and redirects back with a
// `?notice=` the page renders in plain words — a refusal (another person's id) or a 4xx
// from the boundary is reported as a plain problem, never swallowed (no dead controls,
// no silent failure).
//
// Thin by design (the server-composition-roots addendum): per-request data (the search
// params) is read BEFORE `getServerDb()` so `next build` marks the page dynamic and never
// prerenders it or opens the database at build time; config is read INSIDE the handler
// (`loadConfig()`), never at module load; the database comes from the process-wide
// `getServerDb()`, never `createDb`, and the shared handle is never closed. The
// `(protected)` layout already guards every page in the app shell. Config and secrets
// flow only through `loadConfig()` (INV-103) — this entry reads no `process.env` of its
// own, and the seam holds no secret (db + KeyWrapper + Clock are injected).

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the memory actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets the seam unwrap the session person's own DEK
// to decrypt/encrypt their memory content; the system clock stamps a newly added memory.
function buildActions(db: Db): MemoryActions {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  });
  return createMemoryActions({ db, keyWrapper, clock: systemClock });
}

function str(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

// The scope chooser only offers "kept" / "shared"; anything else is normalised to
// "shared" (the add form's default).
function scopeOf(formData: FormData): "kept" | "shared" {
  return str(formData, "scope") === "kept" ? "kept" : "shared";
}

// Run one mutation against the seam under the verified session and redirect back with a
// notice naming the outcome. A reported refusal ({ ok: false }) or a 4xx `HttpError` from
// the validation boundary becomes `problem` — shown in plain words, never swallowed; a
// genuine fault rethrows.
async function run(
  success: Notice,
  mutate: (
    actions: MemoryActions,
    session: Session,
  ) => Promise<{ ok: boolean }>,
): Promise<never> {
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let notice: Notice = success;
  try {
    const result = await mutate(buildActions(db), session);
    if (!result.ok) {
      notice = "problem";
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = error.status === 409 ? "storage_full" : "problem";
  }
  revalidatePath("/memory");
  redirect(`/memory?notice=${notice}`);
}

async function addMemoryAction(formData: FormData): Promise<void> {
  "use server";
  await run("added", (actions, session) =>
    actions.addMemory(session, {
      content: str(formData, "content"),
      scope: scopeOf(formData),
    }),
  );
}

async function editMemoryAction(formData: FormData): Promise<void> {
  "use server";
  await run("updated", (actions, session) =>
    actions.editMemory(session, {
      id: str(formData, "id"),
      content: str(formData, "content"),
    }),
  );
}

async function rescopeMemoryAction(formData: FormData): Promise<void> {
  "use server";
  await run("rescoped", (actions, session) =>
    actions.rescopeMemory(session, {
      id: str(formData, "id"),
      scope: scopeOf(formData),
    }),
  );
}

async function deleteMemoryAction(formData: FormData): Promise<void> {
  "use server";
  await run("deleted", (actions, session) =>
    actions.deleteMemory(session, { id: str(formData, "id") }),
  );
}

type Notice =
  | "added"
  | "updated"
  | "rescoped"
  | "deleted"
  | "problem"
  | "storage_full";

const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  added: { done: true, text: "Memory added." },
  updated: { done: true, text: "Memory updated." },
  rescoped: { done: true, text: "Memory updated." },
  deleted: { done: true, text: "Memory deleted." },
  problem: { done: false, text: "Something went wrong. Please try again." },
  storage_full: {
    done: false,
    text: "Storage limit reached. Remove unused items or reduce their size before saving.",
  },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && raw in NOTICES ? (raw as Notice) : null;
}

// The outcome of the last action, in words plus an icon (never colour alone). A problem
// is announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: Notice }) {
  const { done, text } = NOTICES[notice];
  return <InlineNotice tone={done ? "success" : "error"}>{text}</InlineNotice>;
}

function queryOf(raw: string | string[] | undefined): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const notice = toNotice(params.notice);
  const query = queryOf(params.q);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const data = await buildActions(db).load(
    session,
    query,
    typeof params.cursor === "string" ? params.cursor : undefined,
  );

  return (
    <PageContainer className="flex flex-col gap-6">
      {notice ? <NoticeBanner notice={notice} /> : null}
      <MemoryView
        memories={data.memories}
        query={data.query}
        nextCursor={data.nextCursor}
        hasPreviousPage={typeof params.cursor === "string"}
        addAction={addMemoryAction}
        editAction={editMemoryAction}
        rescopeAction={rescopeMemoryAction}
        deleteAction={deleteMemoryAction}
      />
    </PageContainer>
  );
}
