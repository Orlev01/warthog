import * as React from "react";
import { DeviceView } from "@/components/auth/auth-views";

// Thin device entry (task E04-S14): mounts the new-device view at its entry step —
// the code screen that collects the one-time code emailed to the person
// (DeviceView steps code → confirm). It lives under (auth) and OUTSIDE any
// protected route group, so a brand-new device with no session yet can still
// reach it.
export default function AddADevicePage() {
  return <DeviceView step="code" />;
}
