# Isolate releases and passkey vault envelopes

Accepted for local implementation, 9 November 2026. This does not authorize deployment.

Two pre-launch defects can lose access to data: releases are keyed only by person and agent connection, and PRF envelopes only by person and unlock method.

## Decision

Require `approval_id` in `collect_release`. Scope the in-memory key to the authenticated person, connection and approval. Collection remains single-use with five-minute active expiry; no plaintext is persisted. Disconnect discards all pending values for that connection. Update the tool schema and caller guidance together. This is an intentional pre-launch protocol change; there is no ambiguous legacy collection path.

Store new PRF envelopes separately by person and registered credential ID, with an ownership foreign key and deletion cascade. Bind the credential ID into the existing possession-proof transcript via public `params`. Return encrypted envelopes only to their owner, and select the envelope matching the browser assertion. Preserve existing unlabelled envelopes as a legacy fallback; never guess their credential or generate a replacement vault key after failed decryption. Passphrase and recovery envelopes retain their existing contract.

## Implementation and verification

- Add failing regressions for concurrent approval collection and disconnect cleanup, then update callers and tests.
- Add a migration and regressions for multiple credential envelopes, ownership, proof binding and deletion; update client selection and adoption.
- Check reset/export behavior and runtime database grants.
- Complete local messaging disclosures and draft public Terms, without publishing or approving markets.
- Run focused checks, the complete suite, production build and runtime preparation. Attempt clean Linux/container/PostgreSQL validation only with available local tooling; record missing evidence explicitly.

Operational/provider gates, paid provisioning, credentials, DNS and launch approval remain separate.
