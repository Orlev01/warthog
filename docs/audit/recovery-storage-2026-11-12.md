# Recovery storage protection — 12 November 2026

The founder-approved storage and access changes are applied. Receipt storage has
versioning and 14-day blob/container soft deletion, plus a receipt-only rule for
old versions. The private deletion journal has locked 42-day retention with no
protected append writes. The app has only a container-scoped add permission;
its existing grants and production image/configuration are unchanged.

The initial [foundation apply](https://github.com/Orlev01/warthog/actions/runs/43171167804)
partially succeeded, then Azure returned `ContainerImmutabilityPolicyNotFound`
when locking the newly created policy. ARM subsequently confirmed the existing
42-day unlocked policy. Only Terraform's replacement flag for that policy was
cleared; a fresh saved plan matched the independently reviewed single change
from unlocked to locked. The [continuation](https://github.com/Orlev01/warthog/actions/runs/43172531294)
succeeded. Fifteen effective-state checks and a zero-change follow-up plan pass.
The original failed workflow remains recorded as failed.

## Access test and compatibility correction

The single approved synthetic probe created its fixed marker successfully.
Its identical conditional retry returned exactly HTTP403
`UnauthorizedBlobOverwrite`, so the probe stopped. The later overwrite, read,
list and delete-denial checks did not execute. This is incomplete acceptance,
not a passing access test. No account rows, coverage marker or deletion records
were touched, and no permission was broadened.

The adapter correction accepts that exact upload response alongside HTTP412
`ConditionNotMet`, retaining create-if-absent and first-write-wins timestamps.
Other authorization errors, retention conflicts, network failures and SDK setup
errors remain failures. Microsoft documents separate new-blob and overwrite
permissions and an overwrite-specific error; interpreting this response as an
existing marker is supported by those semantics and the observed probe, not a
claim of payload equality or a general rule for all uploads.
[Put Blob permissions](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob#permissions),
[error codes](https://learn.microsoft.com/en-us/rest/api/storageservices/blob-service-error-codes).

Local validation passes 66 deletion/journal/purge tests and TypeScript. Coverage
includes restart with advancing timestamps, a lost upload response, exact error
matching and refusal before an upload occurs. The separately prepared continuation
has 12 offline tests and uses the existing synthetic marker without repeating the
first-create test. Its execution requires a fresh exact approval.

## Remaining gates

The unpublished [image-check run](https://github.com/Orlev01/warthog/actions/runs/43174039594)
was cancelled after the probe exposed the incompatibility. The live activity
organisation release remains healthy on its previous image. Publication of the
corrected candidate, journal activation and the isolated Azure recovery drill
retain separate approval gates. The hosted cleanup supervisor is merged but has
not been dispatched; no recovery clone or new drill-reader grant exists.

Private plans, state, probe result and continuation review remain in the owning
worktree's ignored `.delivery/followup-acceptance-2026-11-12/` directory.
