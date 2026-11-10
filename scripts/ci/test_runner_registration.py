"""Registration must reject bootstrap history before requesting a GitHub token."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    'private_runner_registration', Path(__file__).parents[1] / 'delivery/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class GitHubRegistrationReached(Exception):
    """Stop at the mocked external boundary without generating a credential."""


class RunnerRegistrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.lease_id = '12345678901'
        self.directory = self.root / '.delivery' / ('runner-' + self.lease_id)
        self.directory.mkdir(parents=True)
        expiry = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)
        (self.directory / 'approved.tfvars.json').write_text(json.dumps({
            'lease_id': self.lease_id, 'expires_at': expiry.isoformat(),
        }))
        self.account = {
            'id': runner.SUB, 'tenantId': runner.TENANT,
            'user': {'name': 'orlev94@outlook.com'},
        }
        self.commands_path = (
            f'/subscriptions/{runner.SUB}/resourceGroups/rg-warthog-runner-{self.lease_id}'
            '/providers/Microsoft.Compute/virtualMachines/warthog-runner'
            '/runCommands?api-version=2024-07-01')

    def attempt_registration(self, history, exception):
        github = Mock(side_effect=GitHubRegistrationReached)
        # operate() changes these process/module globals; isolate that from other tests.
        previous_umask = os.umask(0o077)
        try:
            with patch.object(runner, 'ROOT', self.root), \
                    patch.object(runner, 'PRIVATE_DIRECTORY', None), \
                    patch.object(sys, 'argv', ['runner.py', 'register', '--directory', str(self.directory)]), \
                    patch.object(runner, 'run', return_value=json.dumps(self.account)), \
                    patch.object(runner, 'azure', return_value=history) as azure, \
                    patch.object(runner, 'github', github), \
                    patch.object(runner, 'vm_command') as vm_command, \
                    patch.object(runner.urllib.request, 'urlopen', side_effect=AssertionError('Live HTTP forbidden')), \
                    patch('builtins.print'):
                with self.assertRaises(exception) as caught:
                    runner.operate(lambda: None)
                azure.assert_called_once_with(self.commands_path)
                vm_command.assert_not_called()
        finally:
            os.umask(previous_umask)
        return github, caught.exception

    def test_bootstrap_command_on_first_page_refuses_registration(self):
        github, error = self.attempt_registration(
            {'value': [{'name': 'prepare'}, {'name': 'bootstrap-database'}]}, RuntimeError)
        self.assertIn('fresh VM', str(error))
        github.assert_not_called()

    def test_pagination_after_prepare_refuses_registration(self):
        # The undisclosed page may contain a secret-bearing bootstrap command.
        github, error = self.attempt_registration({
            'value': [{'name': 'prepare'}],
            'nextLink': 'https://management.azure.com' + self.commands_path + '&$skiptoken=next',
        }, RuntimeError)
        self.assertIn('fresh VM', str(error))
        github.assert_not_called()

    def test_complete_prepare_only_history_reaches_github_registration(self):
        github, _ = self.attempt_registration(
            {'value': [{'name': 'prepare'}]}, GitHubRegistrationReached)
        github.assert_called_once_with(
            f'repos/{runner.REPO}/actions/runners/generate-jitconfig', 'POST', {
                'name': 'warthog-' + self.lease_id,
                'runner_group_id': 1,
                'labels': ['self-hosted', 'linux', 'x64', 'warthog-production', 'warthog-run-' + self.lease_id],
                'work_folder': '_work',
            })


if __name__ == '__main__':
    unittest.main()
