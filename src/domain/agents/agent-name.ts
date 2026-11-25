// An agent's name as the person types it when renaming the agent
// (docs/adr/agent-names-and-providers.md). Pure: no I/O.
//
// The name is plain metadata (design §4.1): it is stored unencrypted so lists and filters can
// read it, and it reaches other agents (a life-admin record says which agent saved it). So it
// is cleaned before it is stored: invisible characters removed, whitespace collapsed, Unicode
// normalised. A name that the redaction module would change (a card number, a code) is refused
// rather than stored part-hidden.

import { stripInvisible } from "../content/untrusted";
import { redact } from "../redaction/redact";

// The same bound the consent screen and access-key flow put on a new agent's name.
export const AGENT_NAME_MAX = 200;

/** The name to store, or null when nothing usable is left or it holds something private. */
export function normaliseAgentName(raw: string): string | null {
  const name = stripInvisible(raw.normalize("NFC")).text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "" || Array.from(name).length > AGENT_NAME_MAX) return null;
  if (String(redact(name, () => false)) !== name) return null;
  return name;
}
