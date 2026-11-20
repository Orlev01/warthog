"""Installing one optional secret runs on an unregistered lease VM and prints no value."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'private_runner_install_secret', Path(__file__).parents[1] / 'delivery/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

SECRET = 'li-secret-VALUE-123'
URL = 'https://kv-warthog-aue-e854.vault.azure.net/secrets/linkedin-client-secret/' + 'b' * 32


class InstallSecretTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.lease_id = '12345678901'
        self.directory = self.root / '.delivery' / ('runner-' + self.lease_id)
        self.directory.mkdir(parents=True)
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
        (self.directory / 'approved.tfvars.json').write_text(json.dumps({'lease_id': self.lease_id, 'expires_at': expiry.isoformat()}))
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in outside.iterdir()] and None)
        self.value_file = outside / 'linkedin-client-secret'
        self.value_file.write_text(SECRET + '\n')
        self.value_file.chmod(0o600)
        self.account = {'id': runner.SUB, 'tenantId': runner.TENANT, 'user': {'name': 'orlev94@outlook.com'}}

    def install(self, history=None, *, value_file=None, secret='LINKEDIN_CLIENT_SECRET', output=None):
        printed, sent = [], {}
        def run(args, **_):
            if '--resource' in args:
                self.assertEqual(args[args.index('--resource') + 1], 'https://vault.azure.net')
                return json.dumps({'accessToken': 'vault-token'})
            return json.dumps(self.account)
        def vm_command(directory, name, script, protected):
            sent.update(name=name, script=script, protected=protected)
            return {'properties': {'instanceView': {'executionState': 'Succeeded', 'exitCode': 0,
                'output': output if output is not None else json.dumps({'secret_urls': {'LINKEDIN_CLIENT_SECRET': URL}, 'rsa_hsm_roundtrip': True})}}}
        previous_umask = os.umask(0o077)
        try:
            with patch.object(runner, 'ROOT', self.root), patch.object(runner, 'PRIVATE_DIRECTORY', None), \
                    patch.object(sys, 'argv', ['runner.py', 'install-secret', '--directory', str(self.directory),
                                               '--secret', secret, '--value-file', str(value_file or self.value_file)]), \
                    patch.object(runner, 'run', side_effect=run), \
                    patch.object(runner, 'azure', return_value=history if history is not None else {'value': []}), \
                    patch.object(runner, 'github', side_effect=AssertionError('no GitHub call')), \
                    patch.object(runner, 'vm_command', side_effect=vm_command), \
                    patch('builtins.print', side_effect=lambda *a, **k: printed.append(' '.join(map(str, a)))):
                runner.operate(lambda: None)
        finally:
            os.umask(previous_umask)
        return sent, printed

    def test_installs_through_protected_parameters_and_keeps_only_the_versioned_url(self):
        sent, printed = self.install()
        self.assertEqual(sent['name'], 'install-secret')
        self.assertEqual(json.loads(sent['protected']['WARTHOG_SECRET_BUNDLE']), {'LINKEDIN_CLIENT_SECRET': SECRET})
        self.assertEqual(sent['protected']['WARTHOG_VAULT_TOKEN'], 'vault-token')
        self.assertNotIn(SECRET, sent['script'], 'the value travels only as a protected parameter')
        self.assertIn("NAMES = {", sent['script'], 'the reviewed installer runs on the VM')
        self.assertEqual((self.directory / 'secret-url.txt').read_text().strip(), URL)
        self.assertFalse(any(SECRET in line for line in printed))
        self.assertTrue(any(URL in line for line in printed))

    def test_refuses_a_vm_that_ran_anything_but_prepare_or_was_registered(self):
        for history in [{'value': [{'name': 'register'}]}, {'value': [], 'nextLink': 'https://management.azure.com/next'}]:
            with self.subTest(history=history), self.assertRaises(RuntimeError):
                self.install(history)
        (self.directory / 'github-runner.json').write_text('{}')
        with self.assertRaises(RuntimeError):
            self.install()

    def test_refuses_a_readable_value_file_a_value_file_in_the_repository_and_other_secrets(self):
        self.value_file.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'readable'):
            self.install()
        self.value_file.chmod(0o600)
        inside = self.root / 'linkedin-client-secret'
        inside.write_text(SECRET)
        inside.chmod(0o600)
        with self.assertRaises(RuntimeError):
            self.install(value_file=inside)
        with self.assertRaises(SystemExit):
            self.install(secret='GOOGLE_CLIENT_SECRET')

    def test_a_result_without_the_secret_url_is_a_failure(self):
        with self.assertRaises(RuntimeError):
            self.install(output='Secret installation stopped: RuntimeError; no values displayed.')

    def test_a_vm_that_installed_a_secret_can_never_register(self):
        import test_runner_registration as registration
        self.assertTrue(hasattr(registration, 'RunnerRegistrationTests'))
        # register refuses any command other than prepare (pinned in test_runner_registration);
        # the operation's name is what makes that true here.
        sent, _ = self.install()
        self.assertNotEqual(sent['name'], 'prepare')


if __name__ == '__main__':
    unittest.main()
