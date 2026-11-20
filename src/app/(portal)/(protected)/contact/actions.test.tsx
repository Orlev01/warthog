// "Contact us" in the app (`./actions` + <ContactView/>; docs/adr/requests-for-members.md).
// A signed-in person writes to the operator from inside Warthog: the loader hands back their
// own address (where the reply goes) and their own messages with whether each has been
// answered; `send` records a message for the SESSION person and reports the outcome as one of
// the page's notice codes. The view renders the form, the person's messages, and no address
// but their own.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createContactActions } from "./actions";
import { contactNotice } from "./notices";
import { ContactView } from "@/components/contact/contact-view";
import { createUser } from "@/server/db/users";
import { listConnectorRequestsForUser } from "@/server/db/connector-requests";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-11-20T01:00:00.000Z");
const session = (userId: string): Session => ({ id: `s-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null });
const noop = async (): Promise<void> => {};

test("a person sends a message for themselves and sees it listed, answered once the operator closes it", async () => {
  const db = await freshDb();
  try {
    const me = await createUser(db, { email: "me@example.test", wrappedDek: "w" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "w" });
    const actions = createContactActions({ db, clock: fixedClock(NOW) });

    assert.equal(await actions.send(session(me.id), { topic: "problem", message: "Undo didn't work on my calendar event.\n\nIt stayed put." }), "sent");
    assert.equal(await actions.send(session(other.id), { topic: "idea", message: "Someone else's note" }), "sent");
    assert.equal((await listConnectorRequestsForUser(db, me.id))[0]!.userId, me.id);

    let data = await actions.load(session(me.id));
    assert.equal(data.email, "me@example.test");
    assert.deepEqual(data.messages.map((m) => [m.topic, m.excerpt, m.answered]), [
      ["Something isn't working", "Undo didn't work on my calendar event. It stayed put.", false],
    ]);
    assert.ok(data.messages[0]!.sentAt.length > 0);

    await db.query("UPDATE connector_requests SET handled_at = $2::timestamptz WHERE user_id = $1", [me.id, NOW.toISOString()]);
    data = await actions.load(session(me.id));
    assert.equal(data.messages[0]!.answered, true);
  } finally {
    await db.close();
  }
});

test("each refusal comes back as a notice the page can show", async () => {
  const db = await freshDb();
  try {
    const me = await createUser(db, { email: "me@example.test", wrappedDek: "w" });
    const actions = createContactActions({ db, clock: fixedClock(NOW) });
    assert.equal(await actions.send(session(me.id), { topic: "question", message: "  " }), "empty");
    assert.equal(await actions.send(session(me.id), { topic: "question", message: "x".repeat(2001) }), "too-long");
    assert.equal(await actions.send(session(me.id), { topic: "nope", message: "hi" }), "topic");
    for (let i = 0; i < 5; i += 1) await actions.send(session(me.id), { topic: "other", message: `note ${i}` });
    assert.equal(await actions.send(session(me.id), { topic: "other", message: "one more" }), "too-many");
    for (const code of ["sent", "empty", "too-long", "topic", "too-many", "problem"]) {
      assert.ok(contactNotice(code), code);
    }
    assert.equal(contactNotice("javascript:alert(1)"), null);
    assert.equal(contactNotice(undefined), null);
  } finally {
    await db.close();
  }
});

test("the page shows the form, where the reply goes, and the person's messages", () => {
  const markup = renderToStaticMarkup(
    <ContactView
      email="me@example.test"
      messages={[{ id: "1", topic: "A privacy request", excerpt: "Please send me my data.", sentAt: "20 Nov 2026", answered: false }]}
      notice={contactNotice("sent")}
      sendAction={noop}
    />,
  );
  assert.match(markup, /<h1[^>]*>Contact us<\/h1>/);
  assert.match(markup, /me@example\.test/);
  assert.match(markup, /<select[^>]*name="topic"/);
  for (const label of ["A question", "Something isn&#x27;t working", "A privacy request", "An idea", "Something else"]) {
    assert.ok(markup.includes(label), label);
  }
  assert.match(markup, /<textarea[^>]*name="message"[^>]*maxLength="2000"|<textarea[^>]*maxLength="2000"[^>]*name="message"/);
  assert.match(markup, /Send message/);
  assert.match(markup, /Your messages/);
  assert.match(markup, /Please send me my data\./);
  assert.match(markup, />Sent</);
  assert.match(markup, /href="\/connectors\?view=catalogue"/, "a service request belongs on Connectors");

  const empty = renderToStaticMarkup(<ContactView email="me@example.test" messages={[]} />);
  assert.ok(!empty.includes("Your messages"), "no list until there's a message");
  assert.match(empty, /disabled=""/, "with no action bound, the send button is disabled rather than dead");
});
