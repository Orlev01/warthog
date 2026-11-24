// What an agent can read to build the person's profile (src/domain/life-admin/profile-sources.ts;
// docs/adr/profile-build.md): the person's email, calendars and files through Warthog's own
// connectors, by account, when connected and readable by this agent.
import { test } from "node:test";
import assert from "node:assert/strict";

import { PROFILE_SOURCE_CONNECTORS, readableSourceNames, readableSources, sourcesPhrase } from "./profile-sources";

test("mail, calendar and files come from Warthog's own connectors", () => {
  assert.deepEqual(Object.fromEntries(PROFILE_SOURCE_CONNECTORS), {
    "google-gmail": "mail",
    "microsoft-outlook-mail": "mail",
    "google-calendar": "calendar",
    "microsoft-outlook-calendar": "calendar",
    "google-drive": "files",
    "microsoft-onedrive": "files",
  });
});

test("an account counts only when it's connected and this agent may read it", () => {
  assert.deepEqual(
    readableSources([
      { connectorId: "google-gmail", connected: true, reads: true },
      { connectorId: "google-calendar", connected: true, reads: false },
      { connectorId: "google-drive", connected: false, reads: true },
    ]),
    ["mail"],
  );
  assert.deepEqual(
    readableSources([
      { connectorId: "google-drive", connected: true, reads: true },
      { connectorId: "microsoft-outlook-calendar", connected: true, reads: true },
      { connectorId: "microsoft-outlook-mail", connected: true, reads: true },
      { connectorId: "google-gmail", connected: true, reads: true },
    ]),
    ["mail", "calendar", "files"],
    "each once, in a fixed order",
  );
});

test("LinkedIn and services that ask before every read never count", () => {
  assert.deepEqual(
    readableSources([
      { connectorId: "linkedin", connected: true, reads: true },
      { connectorId: "notion", connected: true, reads: true },
      { connectorId: "dropbox", connected: true, reads: true },
    ]),
    [],
  );
});

test("the sources in plain words", () => {
  assert.equal(sourcesPhrase(["mail"]), "email");
  assert.equal(sourcesPhrase(["mail", "calendar"]), "email and calendar");
  assert.equal(sourcesPhrase(["mail", "calendar", "files"]), "email, calendar and files");
  assert.equal(sourcesPhrase(["files"]), "files");
  assert.equal(sourcesPhrase([]), "");
});

test("the readable services by the names the person knows them", () => {
  assert.deepEqual(readableSourceNames([
    { connectorId: "google-drive", connected: true, reads: true },
    { connectorId: "google-gmail", connected: true, reads: true },
    { connectorId: "google-gmail", connected: true, reads: true },
    { connectorId: "google-calendar", connected: false, reads: true },
    { connectorId: "notion", connected: true, reads: true },
  ]), ["Gmail", "Google Drive"]);
});
