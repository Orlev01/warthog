import assert from "node:assert/strict";
import type { SigninHandler } from "../app/(auth)/signin/handler";
import type { Db } from "../server/db/index";
import { issueEmailCode } from "../server/auth/email-code";
import { createOutbox } from "../server/notify/outbox";
import { fixedClock, type Clock } from "../server/seams/clock";
import { systemRandom } from "../server/seams/random";

// Establish the real email-code prerequisite for tests of the independent TOTP
// behavior. The code exists only in this synthetic sender, never in a fixture log.
export async function emailProofFor(handler: SigninHandler, db: Db, email: string,
  deps: { clock: Clock; hmacKey: Uint8Array; origin: string; issuedAt?: Date }): Promise<string> {
  const sender = createOutbox();
  const issued = await issueEmailCode(db, email, { purpose: "signin_totp", hmacKey: deps.hmacKey,
    clock: deps.issuedAt ? fixedClock(deps.issuedAt) : deps.clock, random: systemRandom, emailSender: sender });
  assert.equal(issued.ok, true);
  const code = sender.list().at(-1)?.body.match(/\b\d{6}\b/)?.[0];
  assert.ok(code);
  const response = await handler.verifyTotpEmail(new Request(`${deps.origin}/api/auth/signin/verify-email`, {
    method: "POST", headers: { origin: deps.origin, "content-type": "application/json" }, body: JSON.stringify({ email, code }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json() as { signinId: string };
  assert.match(result.signinId, /^[a-f0-9]{64}$/);
  return result.signinId;
}
