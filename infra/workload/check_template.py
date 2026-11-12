"""Offline source/optional nonsecret parameter guard. No Azure SDK or network."""
import json
from pathlib import Path
import re
import sys

template = json.loads(Path(__file__).with_name("container-app.template.json").read_text())
assert len(template["resources"]) == 1
app = template["resources"][0]
assert app["type"] == "Microsoft.App/containerApps"
assert app["apiVersion"] == "2025-01-01" and app["location"] == "australiaeast"
config = app["properties"]["configuration"]
assert config["activeRevisionsMode"] == "Multiple"
assert config["ingress"]["external"] is True and config["ingress"]["allowInsecure"] is False
assert config["ingress"]["targetPort"] == 3000
assert "dapr" not in config and "outputs" not in template
assert app["properties"]["template"]["scale"] == {"minReplicas": 1, "maxReplicas": 1, "rules": []}
containers = app["properties"]["template"]["containers"]
assert len(containers) == 1 and "command" not in containers[0]
variables = template["variables"]
assert config["secrets"] == "[concat(variables('baseSecrets'), if(parameters('smsEnabled'), variables('smsSecrets'), json('[]')))]"
assert containers[0]["env"] == "[concat(variables('baseEnvironment'), if(parameters('smsEnabled'), variables('smsEnvironment'), json('[]')))]"
secrets = variables["baseSecrets"] + variables["smsSecrets"]
assert all(set(secret) == {"name", "keyVaultUrl", "identity"} for secret in secrets)
assert all("defaultValue" not in definition for definition in template["parameters"].values())
env = variables["baseEnvironment"] + variables["smsEnvironment"]
assert len({item["name"] for item in env}) == len(env)
secret_env = {item["name"] for item in env if "secretRef" in item}
public_env = {item["name"] for item in env if "parameters('productionEnvironment')" in item.get("value", "")}
assert {item["secretRef"] for item in env if "secretRef" in item} == {item["name"] for item in secrets}
sms_public_env = {item["name"] for item in variables["smsEnvironment"] if "value" in item}
sms_secret_env = {item["name"] for item in variables["smsEnvironment"] if "secretRef" in item}
assert sms_secret_env == {"TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"}
assert sms_public_env == {"TWILIO_REGION", "SMS_COUNTRY_ROUTES_JSON", "SMS_MONTHLY_SEGMENT_LIMIT", "SMS_DAILY_SEGMENT_LIMIT", "SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT", "SMS_RECIPIENT_DAILY_MESSAGE_LIMIT", "SMS_MAX_SEGMENTS_PER_MESSAGE"}
assert {item["secretRef"] for item in variables["smsEnvironment"] if "secretRef" in item} == {item["name"] for item in variables["smsSecrets"]}
assert next(item for item in variables["baseEnvironment"] if item["name"] == "SMS_ENABLED")["value"] == "[if(parameters('smsEnabled'), 'true', 'false')]"
assert not any(item["name"].startswith(("TWILIO_", "SMS_")) and item["name"] != "SMS_ENABLED" for item in variables["baseEnvironment"])
assert all("if(parameters('smsEnabled')," in item["keyVaultUrl"] for item in variables["smsSecrets"])
assert {item["type"] for item in containers[0]["probes"]} == {"Startup", "Readiness", "Liveness"}
for probe in containers[0]["probes"]:
    assert 1 <= probe["failureThreshold"] <= 10
    assert probe["httpGet"]["port"] == 3000
    assert probe["httpGet"]["path"] == ("/api/health/live" if probe["type"] == "Liveness" else "/api/health")

if len(sys.argv) > 1:
    # Values are never printed, including on failure. This does not submit approval
    # or establish that any referenced identity, secret, image or capacity exists.
    supplied = json.loads(Path(sys.argv[1]).read_text())["parameters"]
    assert set(supplied) == set(template["parameters"]), "Parameter names differ from the reviewed contract"
    assert all(set(item) == {"value"} for item in supplied.values()), "Only explicit nonsecret parameter values are supported"
    params = {key: item["value"] for key, item in supplied.items()}
    for key, definition in template["parameters"].items():
        expected = {"bool": bool, "string": str, "object": dict, "array": list}[definition["type"]]
        assert type(params[key]) is expected, f"Review parameter type for {key}"
        if "allowedValues" in definition:
            assert params[key] in definition["allowedValues"], f"Review parameter {key}"
    expected_public = public_env if params["smsEnabled"] else public_env - sms_public_env
    expected_secrets = secret_env if params["smsEnabled"] else secret_env - sms_secret_env
    assert set(params["productionEnvironment"]) == expected_public, "Public environment names differ from the SMS capability contract"
    assert set(params["keyVaultSecretUrls"]) == expected_secrets, "Key Vault reference names differ from the SMS capability contract"
    assert all(isinstance(value, str) for value in params["productionEnvironment"].values()), "Environment settings must be strings"
    for value in params["keyVaultSecretUrls"].values():
        assert isinstance(value, str) and re.fullmatch(r"https://[a-z0-9-]+\.vault\.azure\.net/secrets/[A-Za-z0-9-]+/[a-fA-F0-9]{32}", value), "Require version-pinned Key Vault secret URLs"
    prefix = "/subscriptions/e854f594-274f-4051-841b-78df7655d73c/resourceGroups/"
    for name, kind in [("environmentResourceId", "Microsoft.App/managedEnvironments"), ("managedIdentityResourceId", "Microsoft.ManagedIdentity/userAssignedIdentities")]:
        assert params[name].startswith(prefix) and f"/providers/{kind}/" in params[name], f"Review Warthog scope for {name}"
    assert re.fullmatch(r"[a-z0-9]+\.azurecr\.io", params["registryServer"]), "Require reviewed ACR server"
    assert re.fullmatch(re.escape(params["registryServer"]) + r"/[a-z0-9._/-]+@sha256:[a-f0-9]{64}", params["imageDigest"]), "Require an immutable ACR image digest"
    assert re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]", params["appName"]), "Review app name"
    assert re.fullmatch(r"[a-z][a-z0-9-]{0,62}", params["revisionSuffix"]) and "--" not in params["revisionSuffix"] and not params["revisionSuffix"].endswith("-"), "Review revision suffix"
    assert len(params["traffic"]) == 1 and set(params["traffic"][0]) == {"revisionName", "weight"}, "Use one explicit traffic target"
    assert params["traffic"][0]["weight"] == 100 and params["traffic"][0]["revisionName"] == params["appName"] + "--" + params["revisionSuffix"], "Require the explicit new revision target"
    public = params["productionEnvironment"]
    assert public["DELETION_JOURNAL_CONTAINER"] == "account-deletions" and public["STORAGE_CONTAINER"] != public["DELETION_JOURNAL_CONTAINER"], "Require the separate approved deletion journal"
    assert public["PUBLIC_BASE_URL"] == "https://app.warthog.com.au" and public["WEBAUTHN_RP_ID"] == "app.warthog.com.au", "Preserve approved authentication host/RP"
    assert public["RESEND_SENDING_DOMAIN"] == "mail.warthog.com.au", "Preserve reviewed email settings"
    if params["smsEnabled"]:
        assert public["TWILIO_REGION"] == "us1", "Preserve reviewed SMS region"

print("Offline workload structure checked; Azure validation, approval, credentials, singleton evidence and ingress acceptance remain required.")
