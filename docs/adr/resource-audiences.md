# Resource audiences and agent policies

11 November 2026. Resources remain owned by the account. An agent's workspace
controls its effective access, independently of other agents.

Memory has a source default (shared, or kept to its originating agent) plus
explicit per-agent decisions. Those decisions may grant a person-only memory to
one agent or remove one agent from an otherwise shared memory. The memory-read
switch still gates all reads; the write switch remains independent. The global
memory page names the currently connected agents that can read each memory.
Changing a global scope replaces that memory's agent overrides and records an
audit event. Workspace changes affect only that agent and are audited with the
rest of its permissions.

Vault permissions combine the existing low/high-tier switches with either all
fields (including future additions) or explicit field IDs. Low-tier context is
filtered by those IDs. Sensitive requests must match an allowed field; the inbox
offers only allowed fields; a release identifies its chosen field and rechecks
current grants under the permissions lock. The approval records only that field's
ID. Collection rechecks it, so revocation between approval, release and collection
still prevents disclosure. Sensitive values remain device-encrypted at rest and
are held only in the existing one-time release store. Card access is separate.

Each service can override the agent's default read/change policy. Service access,
account selection, per-service policy, global/agent rules, and any additional
provider approval requirement all apply. A service policy cannot grant a service
that is not assigned or choose a different account. Discovery omits disabled tool
classes, and execution rechecks current policy.

Exports retain permissions and memory/skill overrides as reference metadata.
Imported memories start person-only; imported skills require reassignment and
imported packages start disabled. Old agent IDs never silently grant a new agent
access. Task imports similarly require reassignment.

The large connector inventory path now has working `find_tools` and `call_tool`
handlers. Discovery is paginated and returns schemas. Calls use the target tool's
trusted declaration, validation and normal policy/audit path. Unknown targets are
refused and recorded. The end-to-end MCP test uses 90 discovered provider tools.
