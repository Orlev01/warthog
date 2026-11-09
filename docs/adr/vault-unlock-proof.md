# Prove possession before changing vault unlock methods

Status: local implementation decision, 9 November 2026; independent security review and real-browser acceptance required before release. No new dependency.

The existing HTTP endpoint allows a recently stepped-up session to replace an unlock envelope without proving possession of the device-held vault key. A stolen session must not be able to replace an existing vault's methods or add an unrelated key. A boolean supplied by the browser is insufficient.

Derive a separate 256-bit verification key from the random vault key using HKDF-SHA-256 with fixed, versioned domain separation. Enrol it only with the first unlock envelope, in one transaction after locking the user row. Store it encrypted under the person's existing DEK, bound to its table/column/user by the envelope's associated data. The verification key cannot decrypt vault contents or derive the vault key. The server can verify HMAC-SHA-256 proofs with it; this protects against a session-only attacker, not a compromised application server. The server already controls stored envelopes. Never return the verification key in a response or log it.

Every save consumes an unpredictable, five-minute, single-use challenge bound to user, session and method. The HMAC covers version, challenge, method, wrapped envelope and canonically serialized public parameters. Keep a bounded challenge map in the existing process singleton. Restarts invalidate pending proofs. Later saves prove possession with the enrolled key; replacing a method also retains the existing recent step-up requirement. A race to create the first vault commits one key; the losing device must unwrap the winning envelope instead of replacing it.

Existing vaults with methods/data but no verifier cannot silently enrol one using only a session. They remain readable/unlockable; changing methods returns an explicit upgrade-required error. There is no existing production population in the deployment reports. Any import or upgrade of existing development/user data requires a separately reviewed migration plan; do not reset or erase it automatically. Account reset removes this verifier together with the erased vault.

Tasks: prove rejection of missing/wrong/replayed/cross-session/expired/tampered proofs; implement client and server contract; keep existing HTTP validation and step-up tests; verify reset cleanup and runtime database grants; include security/browser review in the release gate.
