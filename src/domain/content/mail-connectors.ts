// Read-side protection — the connectors that carry the person's email, whose reads get the
// checked mail view (docs/adr/read-side-protection.md).
//
// Pure domain module: shared by the result guard and the consent row's wording.

export const MAIL_CONNECTOR_IDS: ReadonlySet<string> = new Set(["google-gmail", "microsoft-outlook-mail"]);
