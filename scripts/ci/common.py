"""Delivery helpers: explicit scope, quiet subprocesses, no credential logging."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

SUBSCRIPTION = "e854f594-274f-4051-841b-78df7655d73c"
TENANT = "72277873-e056-4612-9b1c-7ad58e02fcf3"
ROOT = Path(__file__).resolve().parents[2]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def setting(name, pattern=None):
    value = os.environ.get(name, "")
    require(bool(value), f"Missing required setting: {name}")
    if pattern:
        require(re.fullmatch(pattern, value) is not None, f"Invalid setting: {name}")
    return value


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def command(args, *, accepted=(0,), input_text=None, env=None, timeout=900):
    # Never echo arguments, stdout or stderr on failure: Azure/Terraform/psql may
    # include configuration or connection strings. No shell or command interpolation.
    result = subprocess.run(args, cwd=ROOT, input=input_text, text=True,
                            capture_output=True, env=env, timeout=timeout)
    require(result.returncode in accepted,
            f"{Path(args[0]).name} failed (exit {result.returncode}); inspect privately, not in public logs")
    return result.stdout


def azure(*args):
    return command(["az", *args, "--subscription", SUBSCRIPTION, "--only-show-errors", "-o", "json"])


def gate():
    require(os.environ.get("GITHUB_REPOSITORY") == "Orlev01/warthog", "Wrong repository")
    require(os.environ.get("GITHUB_REF") == "refs/heads/main", "Delivery requires main")
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch required")
    require(os.environ.get("AZURE_DELIVERY_ENABLED") == "true", "Azure delivery is disabled pending setup and approval")
    setting("APPROVAL_REFERENCE", r"[A-Za-z0-9][A-Za-z0-9._:/ -]{2,199}")
    setting("GITHUB_SHA", r"[a-f0-9]{40}")


def account():
    current = json.loads(command(["az", "account", "show", "-o", "json", "--only-show-errors"]))
    require(current.get("id") == SUBSCRIPTION and current.get("tenantId") == TENANT,
            "Azure identity is outside the dedicated Warthog subscription/tenant")


def summary(message):
    print(message)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as stream:
            stream.write(message + "\n")


def main_guard(function):
    os.umask(0o077)
    try:
        function()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    except Exception:
        # Includes JSON parse failures, which can otherwise disclose input values.
        raise SystemExit("Delivery failed; no automatic retry, rollback, or secret output. Inspect privately.") from None
