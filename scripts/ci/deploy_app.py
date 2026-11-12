"""Approved singleton releases, with a separately reviewed journal activation."""
import copy
import json
import os
from pathlib import Path
import re
import signal
import tempfile
import time
import urllib.request
from urllib.parse import parse_qs, unquote, urlparse

from common import (ROOT, account, azure, canonical, command, digest, gate,
                    main_guard, require, setting, summary)


def fingerprint(app):
    properties = copy.deepcopy(app["properties"])
    # Azure revision copies may serialize an absent secret-backed literal as "".
    # Normalize only this equivalent representation; retain every real value.
    for container in (properties.get("template") or {}).get("containers", []):
        for entry in container.get("env", []):
            if entry.get("secretRef") and entry.get("value") == "":
                del entry["value"]
    # These are the mutable app settings relevant to an image-only update.
    return digest(canonical({"identity": app.get("identity"), "tags": app.get("tags"),
        "location": app.get("location"), **{key: properties.get(key) for key in
        ["environmentId", "managedEnvironmentId", "workloadProfileName", "configuration", "template"]}}))


def validate_live(app):
    p = app["properties"]
    c, t = p["configuration"], p["template"]
    require(app.get("location", "").replace(" ", "").lower() == "australiaeast", "Wrong app region")
    require(c["activeRevisionsMode"] == "Multiple", "Existing app must already use reviewed multiple-revision mode")
    require(t["scale"]["minReplicas"] == t["scale"]["maxReplicas"] == 1
            and not t["scale"].get("rules"), "Existing app violates singleton scaling")
    require(len(t["containers"]) == 1 and not t.get("initContainers") and not t.get("volumes"),
            "Unexpected sidecars, init containers or volumes")
    container = t["containers"][0]
    require(container["name"] == "warthog" and not container.get("command") and not container.get("args"),
            "Unexpected process entrypoint")
    require(container["resources"]["cpu"] == 0.5 and container["resources"]["memory"] == "1Gi",
            "Workload allocation differs from the reviewed contract")
    probes = {p["type"]: p for p in container["probes"]}
    require(set(probes) == {"Startup", "Readiness", "Liveness"}, "Missing health probes")
    for name, probe in probes.items():
        expected_path = "/api/health/live" if name == "Liveness" else "/api/health"
        require(probe.get("httpGet", {}).get("path") == expected_path
                and probe["httpGet"].get("port") == 3000, "Unexpected probe endpoint")
    ingress = c["ingress"]
    require(ingress["external"] is True and ingress["allowInsecure"] is False
            and ingress["targetPort"] == 3000, "Unexpected ingress configuration")
    require(all(not rule.get("latestRevision") for rule in ingress.get("traffic", [])),
            "Latest-revision traffic could expose a new revision before validation")
    require(not (c.get("dapr") or {}).get("enabled"), "Dapr is outside this release contract")
    require(all(s.get("keyVaultUrl") and not s.get("value") for s in c["secrets"]),
            "Only existing Key Vault secret references are supported")
    env = {item["name"]: item for item in container["env"]}
    require(env["PUBLIC_BASE_URL"].get("value") == "https://app.warthog.com.au"
            and env["WEBAUTHN_RP_ID"].get("value") == "app.warthog.com.au",
            "Production authentication hostname differs")


class Platform:
    def __init__(self):
        self.app = setting("APP_NAME", r"[a-z][a-z0-9-]{0,29}[a-z0-9]")
        self.group = setting("RESOURCE_GROUP", r"[A-Za-z0-9._-]+")
        self.scope = ["--resource-group", self.group, "--name", self.app]

    def current(self):
        apps = json.loads(azure("containerapp", "list", "--resource-group", self.group))
        matches = [app for app in apps if app["name"] == self.app]
        require(len(matches) <= 1, "Ambiguous app inventory")
        # List responses can omit fields. Always fetch the complete app before hashing.
        return json.loads(azure("containerapp", "show", *self.scope)) if matches else None

    def revisions(self):
        return json.loads(azure("containerapp", "revision", "list", *self.scope, "--all"))

    def replicas(self, revision):
        return json.loads(azure("containerapp", "replica", "list", *self.scope, "--revision", revision))

    def deactivate(self, revision):
        azure("containerapp", "revision", "deactivate", *self.scope, "--revision", revision)

    def wait_stopped(self, timeout=600):
        deadline = time.monotonic() + timeout
        while True:
            revisions = self.revisions()
            if all(not r["properties"]["active"] and not self.replicas(r["name"]) for r in revisions):
                return
            require(time.monotonic() < deadline, "Old processes did not stop within the maintenance deadline")
            time.sleep(10)

    def ownership(self, expected_free):
        connection = setting("OWNERSHIP_DATABASE_URL")
        parsed = urlparse(connection)
        query = parse_qs(parsed.query)
        require(parsed.scheme in ("postgres", "postgresql") and parsed.path == "/warthog"
                and parsed.hostname == setting("POSTGRES_FQDN", r"[a-z0-9-]+\.postgres\.database\.azure\.com")
                and (parsed.port or 5432) == 5432 and parsed.username and parsed.password
                and query.get("sslmode") == ["verify-full"]
                and set(query) <= {"sslmode", "sslrootcert"}
                and all(len(values) == 1 for values in query.values()),
                "Ownership client must target the approved Warthog database with verified TLS")
        # libpq does not expand a URI in PGDATABASE. Use explicit connection fields,
        # discarding ambient PG settings so another profile cannot redirect the check.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
        environment.update(PGHOST=parsed.hostname, PGPORT="5432", PGDATABASE="warthog",
                           PGUSER=unquote(parsed.username), PGPASSWORD=unquote(parsed.password),
                           PGSSLMODE="verify-full", PGCONNECT_TIMEOUT="10",
                           PGAPPNAME="warthog-release-ownership-check", PGOPTIONS="-c statement_timeout=10000")
        if "sslrootcert" in query:
            environment["PGSSLROOTCERT"] = query["sslrootcert"][0]
        result = command(["psql", "-X", "--no-password", "-At", "-v", "ON_ERROR_STOP=1"], env=environment,
            input_text="SELECT pg_try_advisory_lock(1463898708, 1);\nSELECT pg_advisory_unlock(1463898708, 1);\n", timeout=30)
        expected = ["t", "t"] if expected_free else ["f", "f"]
        require(result.strip().splitlines() == expected, "Database ownership evidence differs; do not start another process")


def stop_before_start(platform, previous):
    if previous:
        for revision in platform.revisions():
            if revision["properties"]["active"]:
                platform.deactivate(revision["name"])
        platform.wait_stopped()
    platform.ownership(expected_free=True)


def journal_activation(previous, operation):
    value = os.environ.get("ACTIVATE_DELETION_JOURNAL", "false")
    require(value in ("true", "false", ""), "Invalid journal activation selection")
    if value != "true":
        return False
    require(operation == "update" and previous is not None, "Journal activation requires an existing app update")
    env = previous["properties"]["template"]["containers"][0]["env"]
    require(not any(item["name"] == "DELETION_JOURNAL_CONTAINER" for item in env),
            "Journal is already configured; inspect rather than replace it")
    return True


def verify_image(image, *, require_journal=False):
    registry = setting("ACR_NAME", r"[a-z0-9]{5,50}")
    require(re.fullmatch(re.escape(registry) + r"\.azurecr\.io/warthog@sha256:[a-f0-9]{64}", image),
            "Require an approved immutable image from this Warthog registry")
    command(["az", "acr", "login", "--name", registry, "--only-show-errors", "-o", "none"])
    command(["docker", "pull", image])
    item = json.loads(command(["docker", "image", "inspect", image]))[0]
    labels = item["Config"].get("Labels", {})
    require(item["Os"] == "linux" and item["Architecture"] == "amd64"
            and item["Config"]["User"] == "node", "Image runtime contract differs")
    require(labels.get("org.opencontainers.image.revision") == setting("GITHUB_SHA"),
            "Image source differs from the reviewed workflow commit")
    require(labels.get("io.warthog.verified") == "linux-pg16"
            and re.fullmatch(r"node:22-bookworm-slim@sha256:[a-f0-9]{64}", labels.get("org.opencontainers.image.base.name", "")),
            "Image lacks the checked, pinned-base publication contract")
    journal_version = labels.get("io.warthog.deletion-journal")
    require(journal_version in (None, "v1"), "Unsupported deletion journal image contract")
    require(not require_journal or journal_version == "v1",
            "A journal-enabled app cannot run an image without deletion journal support")
    # The v1 runtime requires journal configuration at startup. Reject an image
    # that needs activation BEFORE maintenance stops the currently healthy app.
    require(journal_version != "v1" or require_journal,
            "A deletion journal image requires existing configuration or explicit approved activation")


def wait_ready(platform, revision, image, timeout=720):
    deadline = time.monotonic() + timeout
    while True:
        revisions = platform.revisions()
        others = [r for r in revisions if r["name"] != revision]
        require(all(not r["properties"]["active"] and not platform.replicas(r["name"]) for r in others),
                "Another revision is active; maintenance freeze was violated")
        target = next((r for r in revisions if r["name"] == revision), None)
        if target and target["properties"].get("healthState") == "Healthy":
            require(target["properties"]["template"]["containers"][0]["image"] == image, "Running digest differs")
            if target["properties"]["active"] and len(platform.replicas(revision)) == 1:
                return
        require(time.monotonic() < deadline, "New revision did not become healthy within the deadline")
        time.sleep(10)


def release(platform, operation, image, suffix, scratch):
    previous = platform.current()
    activate_journal = journal_activation(previous, operation)
    if operation == "inspect":
        require(previous is not None, "No app exists; use the separately approved create operation")
        validate_live(previous)
        summary(f"Current app configuration SHA-256: `{fingerprint(previous)}`. Review the live settings privately before update approval.")
        return
    require((operation == "create") == (previous is None), "Create/update selection does not match live app existence")
    revision = platform.app + "--" + suffix
    if previous:
        validate_live(previous)
        require(fingerprint(previous) == setting("EXPECTED_CONFIG_SHA256", r"[a-f0-9]{64}"),
                "Live configuration changed or was not reviewed; inspect and approve again")
        require(all(r["name"] != revision for r in platform.revisions()), "Revision suffix already exists")
    else:
        params = json.loads(setting("WORKLOAD_PARAMETERS_JSON"))
        values = params["parameters"]
        require(values["deploymentApproved"]["value"] is True, "Workload approval is missing")
        require(values["appName"]["value"] == platform.app, "Parameter app name differs")
        require(values["existingCustomDomains"]["value"] == [], "First creation cannot create domain bindings")
        for key, value in {"imageDigest": image, "revisionSuffix": suffix,
                           "traffic": [{"revisionName": revision, "weight": 100}], "priorReplicasStopped": True}.items():
            values[key] = {"value": value}
        # This local candidate is submitted only after the real stop/lock checks.
        parameter_file = scratch / "workload.parameters.json"
        parameter_file.write_bytes(canonical(params))
        command(["python3", "infra/workload/check_template.py", str(parameter_file)])
    journal_configured = previous is not None and any(item["name"] == "DELETION_JOURNAL_CONTAINER"
        for item in previous["properties"]["template"]["containers"][0]["env"])
    verify_image(image, require_journal=activate_journal or journal_configured or operation == "create")
    stop_before_start(platform, previous)
    # Detect a concurrent operator/configuration update after the maintenance stop.
    fresh = platform.current()
    require((fresh is None and previous is None) or
            (fresh is not None and previous is not None and fingerprint(fresh) == fingerprint(previous)),
            "App configuration changed during maintenance; release stopped")
    started = False
    try:
        started = True  # Azure requests can partially succeed before a CLI timeout.
        if previous:
            journal_arguments = ["--set-env-vars", "DELETION_JOURNAL_CONTAINER=account-deletions"] if activate_journal else []
            azure("containerapp", "revision", "copy", *platform.scope,
                  "--from-revision", previous["properties"]["latestRevisionName"],
                  "--image", image, "--revision-suffix", suffix, "--container-name", "warthog", *journal_arguments)
        else:
            azure("deployment", "group", "create", "--resource-group", platform.group,
                  "--name", "warthog-" + suffix, "--mode", "Incremental",
                  "--template-file", "infra/workload/container-app.template.json",
                  "--parameters", "@" + str(parameter_file))
        wait_ready(platform, revision, image)
        platform.ownership(expected_free=False)
        azure("containerapp", "ingress", "traffic", "set", *platform.scope, "--revision-weight", revision + "=100")
        live = platform.current()
        traffic = live["properties"]["configuration"]["ingress"]["traffic"]
        require(len(traffic) == 1 and traffic[0].get("revisionName") == revision
                and traffic[0].get("weight") == 100 and not traffic[0].get("latestRevision"), "Traffic target differs")
        if previous:
            expected = copy.deepcopy(previous)
            expected["properties"]["template"]["revisionSuffix"] = suffix
            expected["properties"]["template"]["containers"][0]["image"] = image
            if activate_journal:
                expected["properties"]["template"]["containers"][0]["env"].append(
                    {"name": "DELETION_JOURNAL_CONTAINER", "value": "account-deletions"})
            expected["properties"]["configuration"]["ingress"]["traffic"] = traffic
            require(fingerprint(live) == fingerprint(expected), "Release changed unapproved configuration")
        host = live["properties"]["configuration"]["ingress"]["fqdn"]
        require(re.fullmatch(r"[a-z0-9.-]+\.azurecontainerapps\.io", host), "Unexpected health hostname")
        with urllib.request.urlopen("https://" + host + "/api/health", timeout=30) as response:
            require(response.status == 200, "HTTPS readiness failed")
        # Repeat after routing; this still does not certify all provider/browser flows.
        wait_ready(platform, revision, image, timeout=30)
        summary(f"Approved revision `{revision}` is healthy with one replica and explicit 100% traffic. "
                "Provider/browser/upload/restore acceptance remains a separate launch gate.")
    except BaseException:
        if started:
            # Never reactivate the previous revision automatically. On partial failure
            # stop only this release, then prove termination before an operator retries.
            try:
                if any(r["name"] == revision for r in platform.revisions()):
                    platform.deactivate(revision)
                platform.wait_stopped()
                platform.ownership(expected_free=True)
                summary("Release failed; new revision stopped. Maintenance outage retained. No automatic rollback.")
            except Exception:
                summary("Release failed and termination is unproven. Operator intervention required; do not start another revision.")
        raise


def run():
    gate()
    account()
    operation = setting("OPERATION", r"inspect|create|update")
    suffix = "r" + setting("GITHUB_RUN_ID", r"[0-9]+") + "a" + setting("GITHUB_RUN_ATTEMPT", r"[0-9]+")
    image = os.environ.get("IMAGE_DIGEST", "")
    def interrupted(_signal, _frame):
        raise RuntimeError("Release interrupted; retain maintenance outage")
    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix="warthog-release-") as directory:
        scratch = Path(directory)
        os.environ["DOCKER_CONFIG"] = str(scratch / "docker")
        release(Platform(), operation, image, suffix, scratch)


if __name__ == "__main__":
    main_guard(run)
