import * as React from "react";
import { SigninView } from "@/components/auth/auth-views";

// Thin sign-in entry (task E04-S13): mounts the sign-in view at its entry step — the
// passkey screen (passkeys are the primary, phishing-resistant factor; design §5).
// It lives under (auth) and OUTSIDE any protected route group, so a guard layout can
// never redirect sign-in to itself (a loop) and leave it unreachable.
export default function SignInPage() {
  return <SigninView step="passkey" />;
}
