import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getServerDb } from "../db/server";
import { systemClock } from "../seams/clock";
import { safeReturnPath } from "./return-path";
import { COOKIE_NAME, verifySession } from "./session";

// Public entry pages remain reachable without a session. An existing cookie is
// only a hint: verify it against the same revocation/expiry rules as protected
// pages before skipping sign-in. Anonymous visits never open the database.
export async function redirectSignedInVisitor(
  returnTo?: unknown,
): Promise<void> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return;

  const session = await verifySession(await getServerDb(), token, {
    clock: systemClock,
  });
  if (session) redirect(safeReturnPath(returnTo));
}
