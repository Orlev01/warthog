# Task hand-offs

11 November 2026. A task belongs to its account owner. Portal and agent creation
accept only `any` or a connected agent belonging to that owner. Imported agent
identities are references, so imported tasks become unassigned (`any`).

Updating an unassigned task claims it for ten minutes. Further updates by that
agent renew the claim. Another agent cannot change or complete it while the claim
is active. Setting status `open` releases the claim; completion clears it. The
owner can always reassign, reopen or complete the task. Claims and expiry are
visible in the portal and agent task results. Expiry permits another agent to
resume work; it cannot cancel side effects already running outside Warthog.

Scope validation, lease changes and task mutations share a row lock. Note appends
are transactional even for portal callers, preventing lost concurrent notes.
Existing work assigned to a particular agent continues to use that assignment.
