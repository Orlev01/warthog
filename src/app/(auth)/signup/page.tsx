import * as React from "react";
import { SignupView } from "@/components/auth/auth-views";

// Thin sign-up entry (task E04-S13): mounts the sign-up view at its entry step — the
// details form that collects the person's name and email. It lives under (auth) and
// OUTSIDE any protected route group, so a guard can never redirect sign-up to itself.
export default function CreateYourAccountPage() {
  return <SignupView step="details" />;
}
