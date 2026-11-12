"""Offline regression checks for dangerous delivery failure paths; no cloud calls."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import common
import deploy_app
import foundation


def app_fixture():
    return {"location": "australiaeast", "identity": {"type": "UserAssigned"}, "tags": {},
        "properties": {"latestRevisionName": "warthog--old", "environmentId": "test-environment",
            "workloadProfileName": "Consumption", "configuration": {
                "activeRevisionsMode": "Multiple", "secrets": [{"name": "database-url", "keyVaultUrl": "test-reference"}],
                "ingress": {"external": True, "allowInsecure": False, "targetPort": 3000,
                    "fqdn": "test.australiaeast.azurecontainerapps.io", "customDomains": [{"name": "app.warthog.com.au"}],
                    "traffic": [{"revisionName": "warthog--old", "weight": 100}]}},
            "template": {"revisionSuffix": "old", "scale": {"minReplicas": 1, "maxReplicas": 1, "rules": []},
                "containers": [{"name": "warthog", "image": "old-digest", "resources": {"cpu": 0.5, "memory": "1Gi"},
                    "env": [{"name": "PUBLIC_BASE_URL", "value": "https://app.warthog.com.au"},
                            {"name": "WEBAUTHN_RP_ID", "value": "app.warthog.com.au"}],
                    "probes": [{"type": name, "httpGet": {"port": 3000, "path": path}} for name, path in
                        [("Startup", "/api/health"), ("Readiness", "/api/health"), ("Liveness", "/api/health/live")]]}]}}}


class DeliveryGateTests(unittest.TestCase):
    def test_gate_rejects_missing_setup_or_other_repo_branch_event(self):
        approved = {"GITHUB_REPOSITORY": "Orlev01/warthog", "GITHUB_REF": "refs/heads/main",
                    "GITHUB_EVENT_NAME": "workflow_dispatch", "AZURE_DELIVERY_ENABLED": "true",
                    "APPROVAL_REFERENCE": "approval-123", "GITHUB_SHA": "a" * 40}
        with patch.dict(os.environ, approved, clear=True):
            common.gate()
        for key, value in [("GITHUB_REPOSITORY", "other/warthog"), ("GITHUB_REF", "refs/heads/feature"),
                           ("GITHUB_EVENT_NAME", "pull_request"), ("AZURE_DELIVERY_ENABLED", "false"),
                           ("APPROVAL_REFERENCE", ""), ("APPROVAL_REFERENCE", "approved; reviewed")]:
            with self.subTest(key=key), patch.dict(os.environ, dict(approved, **{key: value}), clear=True):
                with self.assertRaises(RuntimeError):
                    common.gate()

    def test_subprocess_error_never_echoes_credentials(self):
        with self.assertRaises(RuntimeError) as error:
            common.command(["python3", "-c", "import sys; print('SENSITIVE_FIXTURE'); sys.exit(1)"])
        self.assertNotIn("SENSITIVE_FIXTURE", str(error.exception))

    def test_account_rejects_euc_or_other_subscription(self):
        with patch.object(common, "command", return_value=json.dumps({"id": "other", "tenantId": common.TENANT})):
            with self.assertRaises(RuntimeError):
                common.account()


def runtime_image(journal=None):
    labels = {"org.opencontainers.image.revision": "a" * 40,
              "io.warthog.verified": "linux-pg16",
              "org.opencontainers.image.base.name": "node:22-bookworm-slim@sha256:" + "b" * 64}
    if journal is not None:
        labels["io.warthog.deletion-journal"] = journal
    return {"Os": "linux", "Architecture": "amd64", "Config": {"User": "node", "Labels": labels}}


class ImageJournalTests(unittest.TestCase):
    def verify(self, label, configured):
        with patch.dict(os.environ, ACR_NAME="testregistry", GITHUB_SHA="a" * 40), \
             patch.object(deploy_app, "command", return_value=json.dumps([runtime_image(label)])):
            deploy_app.verify_image("testregistry.azurecr.io/warthog@sha256:" + "c" * 64,
                                    require_journal=configured)

    def test_journal_image_requires_existing_configuration_or_explicit_activation(self):
        with self.assertRaises(RuntimeError):
            self.verify("v1", False)

    def test_journal_configuration_rejects_legacy_image(self):
        with self.assertRaises(RuntimeError):
            self.verify(None, True)

    def test_matching_legacy_and_journal_contracts_are_allowed(self):
        self.verify(None, False)
        self.verify("v1", True)

    def test_unknown_journal_contract_cannot_bypass_activation(self):
        for configured in (False, True):
            with self.subTest(configured=configured), self.assertRaises(RuntimeError):
                self.verify("v2", configured)


class PlanTests(unittest.TestCase):
    def test_saved_backend_does_not_bind_apply_to_plan_identity(self):
        coordinates = dict(resource_group_name="reviewed", storage_account_name="reviewed",
                           container_name="state", key="prod.tfstate")
        with patch.dict(os.environ, ARM_CLIENT_ID="plan-principal"):
            planned = foundation.backend_configuration(coordinates)
        with patch.dict(os.environ, ARM_CLIENT_ID="apply-principal"):
            applied = foundation.backend_configuration(coordinates)
        self.assertEqual(planned, applied)
        self.assertNotIn("client_id", planned)
        self.assertTrue(planned["use_oidc"])
        self.assertTrue(planned["use_azuread_auth"])

    def test_apply_rejects_tamper_wrong_commit_inputs_expiry_and_scope(self):
        data = b"saved plan fixture"
        manifest = {"commit": "a" * 40, "sha256": common.digest(data), "inputs_sha256": "inputs",
                    "subscription": common.SUBSCRIPTION, "created_at": 100}
        arguments = dict(commit="a" * 40, inputs_hash="inputs", expected_hash=common.digest(data), now=200)
        foundation.validate_plan(manifest, data, **arguments)
        for key, value in [("commit", "b" * 40), ("inputs_hash", "changed"), ("now", 90000),
                           ("now", 99), ("expected_hash", "0" * 64)]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                foundation.validate_plan(manifest, data, **dict(arguments, **{key: value}))
        with self.assertRaises(RuntimeError):
            foundation.validate_plan(manifest, data + b"tampered", **arguments)
        with self.assertRaises(RuntimeError):
            foundation.validate_plan(dict(manifest, subscription="other"), data, **arguments)

    def test_foundation_refuses_embedded_password_and_unapproved_inputs(self):
        values = {"subscription_id": common.SUBSCRIPTION, "tenant_id": common.TENANT, "provisioning_approved": True}
        backend = dict(resource_group_name="reviewed", storage_account_name="reviewed", container_name="state", key="prod.tfstate")
        foundation.validate_inputs(values, backend)
        for change in [{"provisioning_approved": False}, {"postgres_admin_password": "test-secret"}, {"tenant_id": "other"}]:
            with self.subTest(change=list(change)), self.assertRaises(RuntimeError):
                foundation.validate_inputs(dict(values, **change), backend)
        with self.assertRaises(RuntimeError):
            foundation.validate_inputs(values, dict(backend, access_key="test-secret"))


class SingletonTests(unittest.TestCase):
    def test_journal_configuration_accepts_the_exact_literal_and_optional_azure_null(self):
        self.assertFalse(deploy_app.has_journal_configuration(None))
        old = app_fixture()
        self.assertFalse(deploy_app.has_journal_configuration(old))
        entry = {"name": "DELETION_JOURNAL_CONTAINER", "value": "account-deletions"}
        old["properties"]["template"]["containers"][0]["env"].append(entry)
        self.assertTrue(deploy_app.has_journal_configuration(old))
        entry["secretRef"] = None
        self.assertTrue(deploy_app.has_journal_configuration(old))

    def test_invalid_existing_journal_configuration_never_stops_live_app(self):
        variants = [
            [{"name": "DELETION_JOURNAL_CONTAINER", "value": ""}],
            [{"name": "DELETION_JOURNAL_CONTAINER", "value": "other-container"}],
            [{"name": "DELETION_JOURNAL_CONTAINER", "secretRef": "journal"}],
            [{"name": "DELETION_JOURNAL_CONTAINER", "value": "account-deletions", "secretRef": "journal"}],
            [{"name": "DELETION_JOURNAL_CONTAINER", "value": "account-deletions"}] * 2,
        ]
        for entries in variants:
            with self.subTest(entries=entries):
                platform = self.platform()
                old = app_fixture()
                old["properties"]["template"]["containers"][0]["env"].extend(entries)
                platform.current.return_value = old
                env = {"ACR_NAME": "testregistry", "GITHUB_SHA": "a" * 40,
                       "ACTIVATE_DELETION_JOURNAL": "false", "EXPECTED_CONFIG_SHA256": deploy_app.fingerprint(old)}
                with patch.dict(os.environ, env), \
                     patch.object(deploy_app, "command", return_value=json.dumps([runtime_image("v1")])), \
                     patch.object(deploy_app, "stop_before_start") as stop, \
                     patch.object(deploy_app, "azure") as cloud, tempfile.TemporaryDirectory() as directory:
                    with self.assertRaisesRegex(RuntimeError, "journal"):
                        deploy_app.release(platform, "update", "testregistry.azurecr.io/warthog@sha256:" + "c" * 64,
                                           "new", Path(directory))
                    stop.assert_not_called()
                    cloud.assert_not_called()

    def test_unactivated_journal_image_is_rejected_before_stopping_live_app(self):
        platform = self.platform()
        old = app_fixture()
        platform.current.return_value = old
        env = {"ACR_NAME": "testregistry", "GITHUB_SHA": "a" * 40,
               "ACTIVATE_DELETION_JOURNAL": "false", "EXPECTED_CONFIG_SHA256": deploy_app.fingerprint(old)}
        with patch.dict(os.environ, env), \
             patch.object(deploy_app, "command", return_value=json.dumps([runtime_image("v1")])), \
             patch.object(deploy_app, "stop_before_start") as stop, \
             patch.object(deploy_app, "azure") as cloud, tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "journal"):
                deploy_app.release(platform, "update", "testregistry.azurecr.io/warthog@sha256:" + "c" * 64,
                                   "new", Path(directory))
            stop.assert_not_called()
            cloud.assert_not_called()

    def test_journal_activation_is_explicit_one_time_update_without_existing_env(self):
        old = app_fixture()
        self.assertFalse(deploy_app.journal_activation(old, "update"))
        with patch.dict(os.environ, ACTIVATE_DELETION_JOURNAL="true"):
            self.assertTrue(deploy_app.journal_activation(old, "update"))
            for operation in ["inspect", "create"]:
                with self.assertRaises(RuntimeError):
                    deploy_app.journal_activation(old, operation)
            old["properties"]["template"]["containers"][0]["env"].append(
                {"name": "DELETION_JOURNAL_CONTAINER", "value": "unexpected"})
            with self.assertRaises(RuntimeError):
                deploy_app.journal_activation(old, "update")

    def platform(self):
        platform = Mock(spec=deploy_app.Platform)
        platform.app, platform.group = "warthog", "test-group"
        platform.scope = ["--name", "warthog", "--resource-group", "test-group"]
        platform.revisions.return_value = [{"name": "warthog--old", "properties": {"active": True}},
                                           {"name": "warthog--older", "properties": {"active": False}}]
        return platform

    def test_stop_and_replica_proof_precede_database_check(self):
        platform = self.platform()
        deploy_app.stop_before_start(platform, app_fixture())
        self.assertEqual([call[0] for call in platform.mock_calls],
                         ["revisions", "deactivate", "wait_stopped", "ownership"])
        platform.deactivate.assert_called_once_with("warthog--old")
        platform.ownership.assert_called_once_with(expected_free=True)

    def test_failed_termination_never_checks_lock_or_starts(self):
        platform = self.platform()
        platform.wait_stopped.side_effect = RuntimeError("still running")
        with self.assertRaises(RuntimeError):
            deploy_app.stop_before_start(platform, app_fixture())
        platform.ownership.assert_not_called()

    def test_inactive_revision_with_live_replica_still_blocks(self):
        platform = self.platform()
        platform.revisions.return_value = [{"name": "warthog--old", "properties": {"active": False}}]
        platform.replicas.return_value = [{"name": "still-alive"}]
        with self.assertRaises(RuntimeError):
            deploy_app.Platform.wait_stopped(platform, timeout=0)

    def test_config_hash_covers_dns_secrets_and_environment(self):
        old = app_fixture()
        for key in ["customDomains", "traffic"]:
            changed = copy.deepcopy(old)
            changed["properties"]["configuration"]["ingress"][key] = []
            self.assertNotEqual(deploy_app.fingerprint(old), deploy_app.fingerprint(changed))
        changed = copy.deepcopy(old)
        changed["properties"]["template"]["containers"][0]["env"].append({"name": "NEW", "value": "value"})
        self.assertNotEqual(deploy_app.fingerprint(old), deploy_app.fingerprint(changed))

    def test_config_hash_normalizes_only_empty_secret_backed_values(self):
        original = app_fixture()
        original["properties"]["template"]["containers"][0]["env"].append(
            {"name": "DATABASE_URL", "secretRef": "database-url"})
        normalized = copy.deepcopy(original)
        entry = normalized["properties"]["template"]["containers"][0]["env"][-1]
        entry["value"] = ""
        self.assertEqual(deploy_app.fingerprint(original), deploy_app.fingerprint(normalized))
        self.assertEqual(entry["value"], "")  # Fingerprinting must not mutate its input.
        for change in [{"value": "literal"}, {"secretRef": "different"}, {"secretRef": ""}]:
            changed = copy.deepcopy(normalized)
            changed["properties"]["template"]["containers"][0]["env"][-1].update(change)
            self.assertNotEqual(deploy_app.fingerprint(original), deploy_app.fingerprint(changed))
        literal = copy.deepcopy(original)
        literal["properties"]["template"]["containers"][0]["env"].append({"name": "EMPTY"})
        changed = copy.deepcopy(literal)
        changed["properties"]["template"]["containers"][0]["env"][-1]["value"] = ""
        self.assertNotEqual(deploy_app.fingerprint(literal), deploy_app.fingerprint(changed))

    def test_live_guard_rejects_rolling_mode_second_container_and_latest_traffic(self):
        good = app_fixture()
        deploy_app.validate_live(good)
        bad = copy.deepcopy(good)
        bad["properties"]["configuration"]["activeRevisionsMode"] = "Single"
        with self.assertRaises(RuntimeError):
            deploy_app.validate_live(bad)
        bad = copy.deepcopy(good)
        bad["properties"]["template"]["containers"].append({"name": "another-process"})
        with self.assertRaises(RuntimeError):
            deploy_app.validate_live(bad)
        bad = copy.deepcopy(good)
        bad["properties"]["configuration"]["ingress"]["traffic"] = [{"latestRevision": True, "weight": 100}]
        with self.assertRaises(RuntimeError):
            deploy_app.validate_live(bad)

    def test_live_guard_accepts_azure_null_dapr_but_rejects_enabled_dapr(self):
        app = app_fixture()
        app["properties"]["configuration"]["dapr"] = None
        deploy_app.validate_live(app)
        app["properties"]["configuration"]["dapr"] = {"enabled": True}
        with self.assertRaisesRegex(RuntimeError, "Dapr"):
            deploy_app.validate_live(app)

    def run_update(self, platform):
        with tempfile.TemporaryDirectory() as path:
            deploy_app.release(platform, "update", "new-digest", "new", Path(path))

    def test_changed_config_fails_before_cloud_mutation(self):
        platform = self.platform()
        platform.current.return_value = app_fixture()
        with patch.dict(os.environ, EXPECTED_CONFIG_SHA256="0" * 64), patch.object(deploy_app, "azure") as cloud:
            with self.assertRaises(RuntimeError):
                self.run_update(platform)
            cloud.assert_not_called()
        platform.deactivate.assert_not_called()

    def test_held_database_lock_never_starts_revision(self):
        platform = self.platform()
        old = app_fixture()
        platform.current.return_value = old
        platform.ownership.side_effect = RuntimeError("lock held")
        with patch.dict(os.environ, EXPECTED_CONFIG_SHA256=deploy_app.fingerprint(old)), \
             patch.object(deploy_app, "verify_image"), patch.object(deploy_app, "azure") as cloud:
            with self.assertRaises(RuntimeError):
                self.run_update(platform)
            cloud.assert_not_called()

    def test_drift_during_maintenance_prevents_start(self):
        platform = self.platform()
        old = app_fixture()
        changed = copy.deepcopy(old)
        changed["properties"]["configuration"]["ingress"]["customDomains"] = []
        platform.current.side_effect = [old, changed]
        with patch.dict(os.environ, EXPECTED_CONFIG_SHA256=deploy_app.fingerprint(old)), \
             patch.object(deploy_app, "verify_image"), patch.object(deploy_app, "azure") as cloud:
            with self.assertRaises(RuntimeError):
                self.run_update(platform)
            cloud.assert_not_called()
        platform.ownership.assert_called_once_with(expected_free=True)

    def test_success_preserves_domains_and_changes_only_image_revision_traffic(self):
        platform = self.platform()
        old = app_fixture()
        old["properties"]["template"]["containers"][0]["env"].append(
            {"name": "DATABASE_URL", "secretRef": "database-url"})
        live = copy.deepcopy(old)
        live["properties"]["template"]["containers"][0]["env"][-1]["value"] = ""
        live["properties"]["template"]["revisionSuffix"] = "new"
        live["properties"]["template"]["containers"][0]["image"] = "new-digest"
        live["properties"]["configuration"]["ingress"]["traffic"] = [{"revisionName": "warthog--new", "weight": 100}]
        platform.current.side_effect = [old, old, live]
        response = Mock(status=200)
        with patch.dict(os.environ, EXPECTED_CONFIG_SHA256=deploy_app.fingerprint(old)), \
             patch.object(deploy_app, "verify_image"), patch.object(deploy_app, "azure") as cloud, \
             patch.object(deploy_app, "wait_ready") as ready, patch.object(deploy_app, "summary"), \
             patch.object(deploy_app.urllib.request, "urlopen") as health:
            health.return_value.__enter__.return_value = response
            self.run_update(platform)
            self.assertEqual(cloud.call_count, 2)
            self.assertEqual(cloud.call_args_list[0].args[:3], ("containerapp", "revision", "copy"))
            self.assertNotIn("--replace-env-vars", cloud.call_args_list[0].args)
            self.assertEqual(cloud.call_args_list[1].args[:4], ("containerapp", "ingress", "traffic", "set"))
            self.assertEqual(ready.call_count, 2)
            health.assert_called_once_with("https://test.australiaeast.azurecontainerapps.io/api/health", timeout=30)
        self.assertEqual([call.kwargs for call in platform.ownership.call_args_list],
                         [{"expected_free": True}, {"expected_free": False}])

    def test_first_creation_cannot_bind_a_domain(self):
        platform = self.platform()
        platform.current.return_value = None
        params = {"parameters": {"deploymentApproved": {"value": True}, "appName": {"value": "warthog"},
                                 "existingCustomDomains": {"value": [{"name": "app.warthog.com.au"}]}}}
        with patch.dict(os.environ, WORKLOAD_PARAMETERS_JSON=json.dumps(params)), \
             patch.object(deploy_app, "azure") as cloud, tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                deploy_app.release(platform, "create", "new-digest", "new", Path(directory))
            cloud.assert_not_called()
        platform.ownership.assert_not_called()

    def test_journal_activation_changes_only_exact_env_after_stop_and_keeps_domains(self):
        platform = self.platform()
        old = app_fixture()
        live = copy.deepcopy(old)
        live["properties"]["template"]["revisionSuffix"] = "new"
        live["properties"]["template"]["containers"][0].update(image="new-digest")
        live["properties"]["template"]["containers"][0]["env"].append(
            {"name": "DELETION_JOURNAL_CONTAINER", "value": "account-deletions"})
        live["properties"]["configuration"]["ingress"]["traffic"] = [{"revisionName": "warthog--new", "weight": 100}]
        platform.current.side_effect = [old, old, live]
        with patch.dict(os.environ, ACTIVATE_DELETION_JOURNAL="true", EXPECTED_CONFIG_SHA256=deploy_app.fingerprint(old)), \
             patch.object(deploy_app, "verify_image") as verify, patch.object(deploy_app, "azure") as cloud, \
             patch.object(deploy_app, "wait_ready"), patch.object(deploy_app, "summary"), \
             patch.object(deploy_app.urllib.request, "urlopen") as health:
            health.return_value.__enter__.return_value = Mock(status=200)
            def azure_after_stop(*args):
                platform.wait_stopped.assert_called_once()
                self.assertEqual(platform.ownership.call_args_list[0].kwargs, {"expected_free": True})
            cloud.side_effect = azure_after_stop
            self.run_update(platform)
            verify.assert_called_once_with("new-digest", require_journal=True)
            args = cloud.call_args_list[0].args
            self.assertEqual(args[-2:], ("--set-env-vars", "DELETION_JOURNAL_CONTAINER=account-deletions"))
            self.assertNotIn("--replace-env-vars", args)
        self.assertEqual(len(old["properties"]["template"]["containers"][0]["env"]), 2)

    def test_failed_start_stops_candidate_without_reactivating_old_revision(self):
        platform = self.platform()
        old = app_fixture()
        platform.current.return_value = old
        platform.revisions.side_effect = [
            [{"name": "warthog--old", "properties": {"active": True}}],
            [{"name": "warthog--old", "properties": {"active": True}}],
            [{"name": "warthog--new", "properties": {"active": True}}],
        ]
        with patch.dict(os.environ, EXPECTED_CONFIG_SHA256=deploy_app.fingerprint(old)), \
             patch.object(deploy_app, "verify_image"), patch.object(deploy_app, "azure") as cloud, \
             patch.object(deploy_app, "wait_ready", side_effect=RuntimeError("unhealthy")), \
             patch.object(deploy_app, "summary"):
            with self.assertRaises(RuntimeError):
                self.run_update(platform)
            self.assertEqual(cloud.call_args.args[:3], ("containerapp", "revision", "copy"))
            self.assertEqual(cloud.call_count, 1)
        self.assertEqual(platform.deactivate.call_args.args, ("warthog--new",))
        self.assertEqual(platform.ownership.call_args.kwargs, {"expected_free": True})

    def test_ownership_uses_private_connection_env_not_arguments_and_closes_session(self):
        env = {"APP_NAME": "warthog", "RESOURCE_GROUP": "test-group", "POSTGRES_FQDN": "test.postgres.database.azure.com",
               "OWNERSHIP_DATABASE_URL": "postgresql://fixture:fixture%40encoded@test.postgres.database.azure.com/warthog?sslmode=verify-full",
               "PGSERVICE": "unrelated-profile", "PGHOST": "wrong-host"}
        with patch.dict(os.environ, env), patch.object(deploy_app, "command", return_value="t\nt\n") as run:
            deploy_app.Platform().ownership(expected_free=True)
            self.assertNotIn("fixture", str(run.call_args.args))
            self.assertIn("pg_advisory_unlock", run.call_args.kwargs["input_text"])
            connection_env = run.call_args.kwargs["env"]
            self.assertEqual(connection_env["PGDATABASE"], "warthog")
            self.assertEqual(connection_env["PGHOST"], "test.postgres.database.azure.com")
            self.assertEqual(connection_env["PGPASSWORD"], "fixture@encoded")
            self.assertEqual(connection_env["PGSSLMODE"], "verify-full")
            self.assertNotIn("PGSERVICE", connection_env)
        env["OWNERSHIP_DATABASE_URL"] = "postgresql://fixture:fixture@other.example/warthog?sslmode=verify-full"
        with patch.dict(os.environ, env), patch.object(deploy_app, "command") as run:
            with self.assertRaises(RuntimeError):
                deploy_app.Platform().ownership(expected_free=True)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
