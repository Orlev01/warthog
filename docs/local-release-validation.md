# Local Linux and PostgreSQL release checks

Prepared 9 November 2026; executed successfully 10 November. The final clean Node 22.23.4/Linux ARM64 harness passed **5,072/5,072 tests**, including the AUD-027 startup regressions, TypeScript, production build, runtime staging and PostgreSQL 16.15 checks. See [current evidence](audit/README.md#resumed-local-verification--10-november-2026). No cloud resources, production credentials, public ports or provider accounts are needed. A working Docker daemon and image-download access are required. The Compose database is disposable, uses synthetic data, is held in tmpfs and has trust authentication only on an internal Docker network. Never reuse that configuration for hosting or connect real data.

The new `.github/workflows/ci.yml` runs this same clean Linux/PG16 harness and then
builds the separate non-root runtime image. It grants read-only repository access,
does not persist checkout credentials, pins its official checkout action, and has
no publishing, cloud login or deployment step. Workflow YAML/Compose/script syntax
have been checked locally; no remote CI run has occurred. Review repository
publication and GitHub runner billing before enabling it. The image ID/platform,
source revision and runtime manifest are recorded in CI logs; they are not an
approved production registry digest or production-startup certification.

Current environment: Docker Desktop context `desktop-linux` responds with engine 29.9.3. The old missing-socket/access-denied reports describe the previous session. The successful local suite ran on ARM64; the independent runtime image is built for `linux/amd64`. Remote CI on its Linux AMD64 runner is still a separate gate. No engine permission changes were needed.

Run from the release checkout:

```sh
docker compose -f scripts/local-postgres-check.compose.yaml config --quiet
docker compose -f scripts/local-postgres-check.compose.yaml up --build --abort-on-container-exit --exit-code-from verification
docker compose -f scripts/local-postgres-check.compose.yaml down --volumes
docker build --target runtime --platform linux/amd64 -t warthog-local-release .
```

Always perform the cleanup command even if checks fail; it affects only this uniquely named local Compose project. Do not use a shared Docker project or add host ports. No image push is part of this procedure.

The verification target uses clean `npm ci` on Node 22/Linux, builds Next and stages runtime assets, then runs the complete test suite on the isolated network. It runs the actual `db/bootstrap.psql` in PostgreSQL 16, verifies migration idempotence, login/role boundaries, account deletion cascades and exclusive application ownership. A real concurrent-transaction check holds one household release open, verifies that a second member waits on its lock, then verifies that the second release sees the committed spend and is refused when it would exceed the shared budget. These checks and the independent-backend OAuth/DCR/session/activity contention checks passed. The source/test image is not a deployable image. The final command builds the separate non-root runtime for Azure's intended platform.

The first executed suite found three failures because `.dockerignore` excluded the
public `.env.example` used by configuration and bundle-secret tests. The allowlist
now includes only that fixture; real environment files remain excluded and runtime
staging rejects every `.env*` file. The final run uses the scoped PostCSS 8.5.32
override and regenerated lockfile. The runtime stage removes its unused global npm
CLI and npm/npx binaries; build/test stages still use npm.

Passing these checks still does **not** certify production TLS, the final image's complete production startup, stop/wait/start Azure revisions, browser passkeys or 26-MB ingress. A separate local component exercise did verify that `startProductionOwnership` rejects a duplicate process, exits with code 1 after its PostgreSQL backend is terminated, and permits replacement after connection loss and SIGKILL. Full application/cloud lifecycle acceptance still needs a production-like configuration and the approved Azure deployment. Test database traffic here is isolated and intentionally unencrypted; production remains `sslmode=verify-full` with trusted CA and hostname validation. Never weaken production configuration to make a local check pass.

Before an image is approved, pin the Node base to a reviewed digest, record the release commit, final image digest/platform, lockfile hash, migration/catalogue manifest, successful check logs and remaining external acceptance items. A locally built image tag alone is insufficient.

## Private production bootstrap route

The application image deliberately does not contain psql. After paid infrastructure and credential approval, use an engineer-operated client or separately reviewed ephemeral psql tool container in the same private VNet as PostgreSQL. The client must resolve the private database FQDN and verify its TLS certificate. Review `db/bootstrap.psql` against the dedicated server, execute it as the approved administrator, and set each login's password interactively with `\password`. Store the three encoded URLs directly in Key Vault; do not record them in shell arguments, logs or reports. Remove the temporary client after connectivity and roles are verified. Never add a public database firewall rule as a shortcut. The client resource, image and cost still need a concrete approval before creation.
