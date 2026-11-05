import * as React from "react";
import DeviceFlow from "@/components/auth/device-flow";

// Thin device entry (task E04-S14, wired by E04-S34): mounts the client new-device
// flow, which signs a NEW device in to an existing account by approval from a device
// the person already uses (request the emailed one-time code → wait while the owner
// approves on their other device → collect the session and go to /home). The flow
// renders its first step (the add-this-device code screen) from its own initial state,
// so this entry renders for a signed-out visitor with no session or request scope. It
// lives under (auth) and OUTSIDE any protected route group, so a brand-new device with
// no session yet can still reach it.
export default function AddADevicePage() {
  return <DeviceFlow />;
}
