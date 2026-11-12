# MCP client tool permissions

Claude's connected Warthog tool list confirms authentication and tool discovery.
It does not prove every tool has been exercised or that every listed capability
is granted. Warthog's core tools remain discoverable; each call still checks the
agent's current permissions, rules and ownership. Service tools are discovered
from that agent's granted, connected service accounts.

## Connecting Claude

Use `https://app.warthog.com.au/mcp`, **Sign in now**, **Use Claude's published
identity**, and no request headers. Complete Warthog's sign-in and agent consent.
The service connections you already have in Claude are independent of this
Warthog connection. Warthog controls requests routed through Warthog only.

## Two separate approval controls

Claude's tool permissions govern its own behaviour. Its Auto mode may execute a
tool without a local confirmation even when the tool says “Needs approval”.
To require Warthog approval for service changes, set that agent's service changes
to **Ask first** inside Warthog. A global or agent rule may also require approval.
A Warthog `pending_approval` result means the held action has not executed.
Polling `check_approval` does not approve it; the person must decide in Warthog.
The server rechecks current policy when executing an approved hold.

Cards and protected identity have their separate Warthog approval and release
checks. Listing their request tools does not release data. Sensitive information
that has already been collected cannot be recalled by disconnecting an agent.

## Tool metadata

Every Warthog tool publishes a human-readable title and the standard MCP
read-only, destructive, idempotent and open-world hints. The same metadata is
included when large service inventories use `find_tools`.

- Core context, skill, memory search and task/record listing are reads.
- Creating memories, tasks, records or activity entries is additive; updates
  change existing records. Repeated writes are conservatively non-idempotent.
- Identity/card requests create approvals and can notify the person.
- `check_approval` can execute an approved write, including an external send.
- `collect_release` consumes a single-use release; it is not a repeatable read.
- `call_tool`, mixed-method request tools and unknown provider operations are
  conservatively marked as potentially destructive external changes.
- Trusted curated Gmail search/read tools are reads; draft/send tools are changes.
  Draft creation saves an unsent draft. Sending delivers to the message's To,
  Cc and Bcc recipients when Warthog permits it. Both retain the existing
  recipient/message-policy checks.

These hints help clients describe and classify tools. They never grant access,
prove a provider is trustworthy or replace Warthog's enforcement. Upstream MCP
annotations are not promoted into trusted read-only claims; provider tools keep
their mandatory Warthog approval gate. Routine audit recording does not turn a
data-retrieval tool into a user-facing write.

## Verification and release

Regression checks cover the serialized `tools/list` response, expanded discovery,
unknown/provider tool conservatism, and an attempted Gmail send that stays held
despite caller-supplied approval/read-only claims. No live mailbox is needed for
these tests. After a reviewed deployment, refresh the client's tool list and
check the new labels. Exact categories and confirmation behaviour remain under
the client's control; metadata alone cannot promise a particular Claude UI.

References: [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[Anthropic's connector checklist](https://claude.com/docs/connectors/building/review-criteria),
[Claude connector settings](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).
