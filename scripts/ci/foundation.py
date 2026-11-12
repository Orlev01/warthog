"""Manually gated Terraform plan/apply with private, hash-bound plan storage."""
import json
import os
from pathlib import Path
import re
import tempfile
import time

from common import (ROOT, SUBSCRIPTION, TENANT, account, canonical, command,
                    digest, gate, main_guard, require, setting, summary)


def validate_inputs(values, backend):
    require(values.get("subscription_id") == SUBSCRIPTION and values.get("tenant_id") == TENANT,
            "Foundation must target the dedicated Warthog scope")
    require(values.get("provisioning_approved") is True, "Exact resource and funding approval is missing")
    require("postgres_admin_password" not in values, "Database password must be an ephemeral environment input")
    require(set(backend) == {"resource_group_name", "storage_account_name", "container_name", "key"},
            "Backend must contain only the four reviewed Azure Blob coordinates")
    require(all(isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9._/-]+", v) for v in backend.values()),
            "Invalid backend coordinates")


def changes_digest(data):
    """Bind the entire reviewed managed delta without exposing plan values.

    Data reads and unchanged resources can contain unrelated refreshed state or
    ephemeral inputs. They do not authorize writes. Include every field of each
    changed managed resource, including before/after, unknowns and sensitivity.
    """
    require(data.get("complete", True) is True and not data.get("errored")
            and not data.get("deferred_changes"), "Foundation plan is incomplete")
    changes = []
    addresses = set()
    for item in data.get("resource_changes", []):
        address, mode, change = item["address"], item["mode"], item["change"]
        require(address not in addresses, "Plan contains duplicate resource addresses")
        addresses.add(address)
        require(mode in ("managed", "data"), "Unknown resource mode in plan")
        require(not item.get("previous_address") and not change.get("importing"),
                "Resource moves/imports require a separate migration review")
        actions = change["actions"]
        allowed = (["no-op"], ["read"]) if mode == "data" else (["no-op"], ["create"], ["update"])
        require(actions in allowed,
                "Deletion/replacement or unknown action requires a separate migration review")
        if mode == "managed" and actions != ["no-op"]:
            changes.append(item)
    return digest(canonical({"version": 1, "resource_changes": sorted(changes, key=lambda item: item["address"])}))


def validate_plan(manifest, plan, *, commit, inputs_hash, expected_hash, reviewed_changes_hash, now):
    require(manifest.get("commit") == commit, "Plan belongs to a different source commit")
    require(manifest.get("inputs_sha256") == inputs_hash, "Plan inputs/backend changed; make a new plan")
    require(manifest.get("sha256") == expected_hash == digest(plan), "Plan SHA-256 does not match the approved digest")
    require(manifest.get("changes_sha256") == reviewed_changes_hash,
            "Plan changes do not match the reviewed resource delta")
    require(manifest.get("subscription") == SUBSCRIPTION, "Plan scope differs")
    require(0 <= now - manifest.get("created_at", 0) <= 86400, "Plan expired; make a new plan")


def backend_configuration(backend):
    # Keep stage-specific identity in ARM_CLIENT_ID, not backend configuration:
    # saved plans retain backend config, while plan and apply use distinct principals.
    return dict(backend, subscription_id=SUBSCRIPTION, tenant_id=TENANT,
                use_oidc=True, use_azuread_auth=True)


def blob(operation, plan_id, filename, path):
    command(["az", "storage", "blob", operation, "--auth-mode", "login",
             "--account-name", setting("PLAN_STORAGE_ACCOUNT", r"[a-z0-9]{3,24}"),
             "--container-name", setting("PLAN_CONTAINER", r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]"),
             "--name", f"foundation/{plan_id}/{filename}", "--file", str(path),
             "--overwrite", "false", "--only-show-errors", "--no-progress", "-o", "none"])


def run():
    gate()
    account()
    operation = setting("OPERATION", r"plan|apply")
    reviewed_changes_hash = (setting("REVIEWED_CHANGES_SHA256", r"[a-f0-9]{64}")
                             if operation == "apply" else None)
    values = json.loads(setting("FOUNDATION_TFVARS_JSON"))
    backend = json.loads(setting("FOUNDATION_BACKEND_JSON"))
    validate_inputs(values, backend)
    setting("TF_VAR_postgres_admin_password")
    setting("ARM_CLIENT_ID")
    # Avoid inherited verbose logging and CLI options changing a saved-plan operation.
    for key in list(os.environ):
        if key.startswith(("TF_LOG", "TF_CLI_ARGS")) or key == "LOG_SENSITIVE_DATA":
            os.environ.pop(key)
    os.environ.update(ARM_USE_OIDC="true", ARM_USE_AZUREAD="true",
                      ARM_SUBSCRIPTION_ID=SUBSCRIPTION, ARM_TENANT_ID=TENANT,
                      TF_IN_AUTOMATION="true", TF_INPUT="false")
    inputs_hash = digest(canonical({"values": values, "backend": backend,
                                  "lock": digest((ROOT / "infra/.terraform.lock.hcl").read_bytes())}))
    with tempfile.TemporaryDirectory(prefix="warthog-foundation-") as directory:
        scratch = Path(directory)
        # Backend cache also stays off the persistent runner workspace.
        os.environ["TF_DATA_DIR"] = str(scratch / "terraform-data")
        config = scratch / "backend.tfbackend"
        actual_backend = backend_configuration(backend)
        config.write_text("\n".join(f"{key} = {json.dumps(value)}" for key, value in actual_backend.items()))
        variables = scratch / "approved.tfvars.json"
        variables.write_bytes(canonical(values))
        tf = ["terraform", "-chdir=infra"]
        command([*tf, "init", "-input=false", "-lockfile=readonly", f"-backend-config={config}"])
        plan = scratch / "plan.tfplan"
        manifest_path = scratch / "manifest.json"
        if operation == "plan":
            plan_id = setting("GITHUB_RUN_ID", r"[0-9]+") + "-" + setting("GITHUB_RUN_ATTEMPT", r"[0-9]+")
            command([*tf, "plan", "-input=false", "-lock-timeout=5m", "-detailed-exitcode",
                     f"-var-file={variables}", f"-out={plan}"], accepted=(0, 2))
            data = json.loads(command([*tf, "show", "-json", str(plan)]))
            changes_hash = changes_digest(data)
            change_count = sum(item["mode"] == "managed" and item["change"]["actions"] != ["no-op"]
                               for item in data.get("resource_changes", []))
            plan_hash = digest(plan.read_bytes())
            manifest = {"commit": setting("GITHUB_SHA"), "sha256": plan_hash,
                        "inputs_sha256": inputs_hash, "changes_sha256": changes_hash, "subscription": SUBSCRIPTION,
                        "created_at": int(time.time()), "approval_reference": setting("APPROVAL_REFERENCE")}
            manifest_path.write_bytes(canonical(manifest))
            review = scratch / "review.txt"
            review.write_text(command([*tf, "show", "-no-color", str(plan)]))
            for name, path in [("plan.tfplan", plan), ("review.txt", review), ("manifest.json", manifest_path)]:
                blob("upload", plan_id, name, path)
            summary(f"Private plan `{plan_id}`: SHA-256 `{plan_hash}`; "
                    f"{change_count} managed resource changes; changes SHA-256 `{changes_hash}`. "
                    "Independently review the private resource delta and funding approval before a separate apply dispatch. Expires in 24 hours.")
        else:
            plan_id = setting("PLAN_ID", r"[0-9]+-[0-9]+")
            expected_hash = setting("PLAN_SHA256", r"[a-f0-9]{64}")
            blob("download", plan_id, "plan.tfplan", plan)
            blob("download", plan_id, "manifest.json", manifest_path)
            validate_plan(json.loads(manifest_path.read_text()), plan.read_bytes(),
                          commit=setting("GITHUB_SHA"), inputs_hash=inputs_hash,
                          expected_hash=expected_hash, reviewed_changes_hash=reviewed_changes_hash, now=time.time())
            data = json.loads(command([*tf, "show", "-json", str(plan)]))
            require(changes_digest(data) == reviewed_changes_hash,
                    "Saved plan resource changes differ from the reviewed resource delta")
            command([*tf, "apply", "-input=false", "-lock-timeout=5m", str(plan)], timeout=2700)
            output = scratch / "foundation.json"
            output.write_text(command([*tf, "output", "-json", "foundation"]))
            blob("upload", plan_id, "foundation.json", output)
            summary("Approved saved plan applied. Foundation outputs are private. No app, DNS, application secrets or database login bootstrap was created.")


if __name__ == "__main__":
    main_guard(run)
