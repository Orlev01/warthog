"""Delete expired Warthog runner leases from an independent hosted runner.

The cleanup identity has group-delete rights only on each ephemeral lease group,
and read/write only on the private-bootstrap subnet. It cannot deploy resources,
read secrets, change public DNS or delete production/delivery groups.
"""
import datetime
import json
import re
from common import SUBSCRIPTION, account, command, require, main_guard, summary
from runner_lock import runner_lock

PREFIX = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/"
SUBNET = PREFIX + "rg-warthog-prod-aue/providers/Microsoft.Network/virtualNetworks/vnet-warthog-prod-aue/subnets/private-bootstrap"
API = "https://management.azure.com"


def expired_group(group, now):
    name = group.get("name", "")
    tags = group.get("tags") or {}
    if not re.fullmatch(r"rg-warthog-runner-[0-9]{10,14}", name):
        return False
    if tags.get("application") != "warthog" or tags.get("purpose") != "ephemeral-runner":
        return False
    if tags.get("lease_id") != name.removeprefix("rg-warthog-runner-"):
        return False
    try:
        expiry = datetime.datetime.fromisoformat(tags["expires_at"].replace("Z", "+00:00"))
        return expiry.tzinfo is not None and expiry <= now
    except (ValueError, KeyError, TypeError):
        return False


def detached_subnet(subnet, group_name):
    """Preserve the observed subnet properties; detach only this lease's NAT."""
    props = dict(subnet["properties"])
    nat_id = (props.get("natGateway") or {}).get("id", "")
    expected = PREFIX + group_name + "/providers/Microsoft.Network/natGateways/runner-egress"
    if not nat_id:
        return None
    if nat_id.lower() != expected.lower():
        # A newer lease owns the association. Preserve it and delete only the
        # old group's resources, whose NAT is no longer attached here.
        return None
    props.pop("natGateway")
    for key in ("provisioningState", "ipConfigurations", "resourceNavigationLinks", "serviceAssociationLinks"):
        props.pop(key, None)
    return {"properties": props}


def run():
    import os
    require(os.environ.get("GITHUB_REPOSITORY") == "Orlev01/warthog" and os.environ.get("GITHUB_REF") == "refs/heads/main", "Cleanup requires trusted main")
    require(os.environ.get("AZURE_RUNNER_CLEANUP_ENABLED") == "true", "Runner cleanup is disabled")
    account()
    with runner_lock() as check_lease:
        groups = json.loads(command(["az", "group", "list", "--subscription", SUBSCRIPTION, "-o", "json"]))
        now = datetime.datetime.now(datetime.timezone.utc)
        removed = 0
        for group in groups:
            if not expired_group(group, now):
                continue
            check_lease()
            name = group["name"]
            subnet = json.loads(command(["az", "rest", "--subscription", SUBSCRIPTION, "--url", API + SUBNET + "?api-version=2024-05-01", "-o", "json"]))
            body = detached_subnet(subnet, name)
            if body:
                # ETag protects a concurrent subnet change. A failed conditional write
                # stops deletion instead of disconnecting a new runner lease.
                check_lease()
                command(["az", "rest", "--subscription", SUBSCRIPTION, "--method", "put", "--url", API + SUBNET + "?api-version=2024-05-01", "--headers", "If-Match=" + subnet["etag"], "--body", json.dumps(body), "-o", "none"])
            check_lease()
            command(["az", "group", "delete", "--subscription", SUBSCRIPTION, "--name", name, "--yes", "--no-wait", "-o", "none"])
            removed += 1
        summary(f"Requested cleanup for {removed} expired Warthog runner lease(s). No production resources targeted.")



if __name__ == "__main__":
    main_guard(run)
