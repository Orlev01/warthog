"""Exercise both SMS workload contracts with nonsecret fixture parameters."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def parameters():
    document = json.loads((ROOT / "infra/workload/parameters.example.json").read_text())
    p = document["parameters"]
    scope = "/subscriptions/e854f594-274f-4051-841b-78df7655d73c/resourceGroups/test/providers/"
    values = dict(deploymentApproved=True, priorReplicasStopped=True, smsEnabled=False,
        appName="warthog", environmentResourceId=scope + "Microsoft.App/managedEnvironments/test",
        managedIdentityResourceId=scope + "Microsoft.ManagedIdentity/userAssignedIdentities/test",
        registryServer="test.azurecr.io", imageDigest="test.azurecr.io/warthog@sha256:" + "a" * 64,
        revisionSuffix="test", cpu="0.5", memory="1Gi", traffic=[{"revisionName": "warthog--test", "weight": 100}])
    for key, value in values.items():
        p[key]["value"] = value
    p["productionEnvironment"]["value"].update(PUBLIC_BASE_URL="https://app.warthog.com.au",
        WEBAUTHN_RP_ID="app.warthog.com.au", RESEND_SENDING_DOMAIN="mail.warthog.com.au")
    for key in p["keyVaultSecretUrls"]["value"]:
        p["keyVaultSecretUrls"]["value"][key] = "https://test.vault.azure.net/secrets/test/" + "b" * 32
    return document


class WorkloadSmsTests(unittest.TestCase):
    def check(self, document, succeeds):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "parameters.json"
            path.write_text(json.dumps(document))
            result = subprocess.run(["python3", "infra/workload/check_template.py", str(path)],
                cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, succeeds, result.stderr)

    def test_disabled_requires_core_secrets_and_rejects_twilio_references(self):
        good = parameters()
        self.check(good, True)
        bad = copy.deepcopy(good)
        bad["parameters"]["keyVaultSecretUrls"]["value"]["TWILIO_API_KEY_SECRET"] = "https://test.vault.azure.net/secrets/twilio/" + "c" * 32
        self.check(bad, False)
        bad = copy.deepcopy(good)
        del bad["parameters"]["keyVaultSecretUrls"]["value"]["RESEND_API_KEY"]
        self.check(bad, False)

    def test_enabled_requires_the_complete_sms_contract(self):
        enabled = parameters()
        p = enabled["parameters"]
        p["smsEnabled"]["value"] = True
        self.check(enabled, False)
        template = json.loads((ROOT / "infra/workload/container-app.template.json").read_text())
        for item in template["variables"]["smsEnvironment"]:
            if "secretRef" in item:
                p["keyVaultSecretUrls"]["value"][item["name"]] = "https://test.vault.azure.net/secrets/test/" + "c" * 32
            else:
                p["productionEnvironment"]["value"][item["name"]] = "fixture"
        p["productionEnvironment"]["value"]["TWILIO_REGION"] = "us1"
        self.check(enabled, True)
        p["smsEnabled"]["value"] = "false"
        self.check(enabled, False)

    def test_mode_never_bypasses_release_approval(self):
        for flag in ["deploymentApproved", "priorReplicasStopped"]:
            unapproved = parameters()
            unapproved["parameters"][flag]["value"] = False
            self.check(unapproved, False)


if __name__ == "__main__":
    unittest.main()
