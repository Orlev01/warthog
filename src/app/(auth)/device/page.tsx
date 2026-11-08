import * as React from "react";
import { safeReturnPath } from "@/server/auth/return-path";
import DeviceFlow from "@/components/auth/device-flow";

// Thin device entry (task E04-S14, wired by E04-S34): mounts the client new-device
// flow, which signs a NEW device in to an existing account by approval from a device
// the person already uses (request the emailed one-time code → wait while the owner
// approves on their other device → collect the session and go to /home). The flow
// renders its first step (the add-this-device code screen) from its own initial state,
// so this entry renders for a signed-out visitor with no session or request scope. It
// lives under (auth) and OUTSIDE any protected route group, so a brand-new device with
// no session yet can still reach it.
// Review fix B6: a flow started while signed out (an agent connection, an approval link,
// a household invite) arrives as `?next=<relative path>`; it is validated here (and again
// in the flow) and the person goes back there after success, never off-site.
export default async function AddADevicePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = (await searchParams)?.next;
  return <DeviceFlow returnTo={safeReturnPath(next)} />;
}
