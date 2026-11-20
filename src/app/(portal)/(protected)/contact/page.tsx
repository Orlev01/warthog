import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Metadata } from "next";

import { ContactView } from "@/components/contact/contact-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { verifySession, COOKIE_NAME, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { firstParam } from "@/lib/href";
import type { Db } from "@/server/db/index";
import { createContactActions } from "./actions";
import { contactNotice } from "./notices";

export const metadata: Metadata = { title: "Contact us" };

// "Contact us" (docs/adr/requests-for-members.md): the thin protected-page loader over the
// tested `createContactActions` seam (`./actions`). It reads the signed-in session from the
// host-locked session cookie, loads the person's own address and messages, and binds the send
// action, which re-derives the session (never trusting a client value for identity), records
// the message and comes back with a `?notice=` the page shows in plain words. Per-request data
// is read before the database is opened, so `next build` never prerenders it.

async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

function buildActions(db: Db) {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  return createContactActions({
    db,
    clock: systemClock,
    dekFor: async (userId) => {
      const user = await getUserById(db, userId);
      if (!user) throw new Error("no data key for this user");
      return keyWrapper.unwrap(user.wrappedDek);
    },
  });
}

async function sendAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  const field = (name: string) => {
    const raw = formData.get(name);
    return typeof raw === "string" ? raw : "";
  };
  const notice = await buildActions(db).send(session, { topic: field("topic"), message: field("message") });
  revalidatePath("/contact");
  redirect(`/contact?notice=${notice}`);
}

export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const notice = contactNotice(firstParam((await searchParams).notice));
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  const data = await buildActions(db).load(session);
  return <ContactView {...data} notice={notice} sendAction={sendAction} />;
}
