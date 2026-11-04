// Step-up check: a sensitive action (high-tier release, card release, security
// change, export, delete) demands a fresh re-authentication (design §5: "step-up
// valid 5 minutes"; brief: "WHEN a sensitive action is requested … THE SYSTEM
// SHALL require a passkey or authenticator check completed within the previous 5
// minutes").
//
// This module only READS the step-up timestamp a session carries and judges its
// freshness against the injected Clock — it is factor-agnostic: both the passkey
// check and the TOTP check stamp `steppedUpAt` through recordStepUp, and the value
// reads the same whichever wrote it. A pure function with no I/O, so freshness is
// testable without a db, the network or Azure.

import type { Clock } from "../seams/clock";
import type { Session } from "./session";

const MINUTE_MS = 60 * 1000;

// How long a step-up stays fresh: 5 minutes from when it was recorded.
const STEP_UP_WINDOW_MS = 5 * MINUTE_MS;

// Pass only when the session carries a step-up AND it falls within the last 5
// minutes of the clock. An older step-up (now − steppedUpAt > 5 min) or an absent
// one (steppedUpAt === null) is rejected.
export function requireStepUp(session: Session, deps: { clock: Clock }): boolean {
  if (session.steppedUpAt == null) return false;
  const age = deps.clock.now().getTime() - session.steppedUpAt.getTime();
  return age <= STEP_UP_WINDOW_MS;
}
