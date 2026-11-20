"""The setup installer writes one optional secret, tagged with where it came from, and prints no value."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('install_secrets', Path(__file__).parents[1] / 'delivery/install-secrets.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

VALUE = 'li-secret-VALUE-123'
KID = installer.VAULT + '/keys/warthog-wrap/' + 'c' * 32


class FakeVault:
    def __init__(self):
        self.secrets, self.puts = {}, []

    def __call__(self, request, timeout=None):
        path = request.full_url.removeprefix(installer.VAULT).split('?')[0]
        body = json.loads(request.data) if request.data else None
        if path == '/secrets/linkedin-client-secret' and request.get_method() == 'GET':
            if 'linkedin-client-secret' not in self.secrets:
                raise urllib.error.HTTPError(request.full_url, 404, 'missing', {}, io.BytesIO())
            result = self.secrets['linkedin-client-secret']
        elif path == '/secrets/linkedin-client-secret' and request.get_method() == 'PUT':
            self.puts.append(body)
            result = {'id': installer.VAULT + '/secrets/linkedin-client-secret/' + 'a' * 32, 'value': body['value']}
            self.secrets['linkedin-client-secret'] = result
        elif path.startswith('/secrets/linkedin-client-secret/'):
            result = self.secrets['linkedin-client-secret']
        elif path == '/keys/warthog-wrap':
            result = {'key': {'kid': KID, 'kty': 'RSA-HSM', 'key_ops': ['wrapKey', 'unwrapKey']}}
        elif path.endswith('/wrapkey'):
            result = {'value': body['value']}
        elif path.endswith('/unwrapkey'):
            result = {'value': body['value']}
        else:
            raise AssertionError(path)
        response = io.BytesIO(json.dumps(result).encode())
        response.__enter__ = lambda *a: response
        response.__exit__ = lambda *a: None
        return response


class InstallerTests(unittest.TestCase):
    def run_installer(self, **env):
        vault, printed = FakeVault(), []
        with patch.dict(os.environ, {'WARTHOG_VAULT_TOKEN': 't', 'WARTHOG_SECRET_BUNDLE': json.dumps({'LINKEDIN_CLIENT_SECRET': VALUE}), **env}), \
                patch.object(installer.urllib.request, 'urlopen', side_effect=vault), \
                patch('builtins.print', side_effect=lambda *a, **k: printed.append(' '.join(map(str, a)))):
            installer.main()
        return vault, printed

    def test_an_optional_install_is_tagged_as_one_and_prints_only_the_url(self):
        vault, printed = self.run_installer(WARTHOG_SECRET_ORIGIN='optional-install')
        self.assertEqual(vault.puts[0]['tags']['origin'], 'optional-install')
        output = json.loads(printed[-1])
        self.assertTrue(output['secret_urls']['LINKEDIN_CLIENT_SECRET'].endswith('/linkedin-client-secret/' + 'a' * 32))
        self.assertFalse(any(VALUE in line for line in printed))

    def test_the_setup_tag_stays_the_default_and_a_strange_origin_is_refused(self):
        vault, _ = self.run_installer()
        self.assertEqual(vault.puts[0]['tags']['origin'], 'authorized-setup-2026-11-10')
        with self.assertRaises(RuntimeError):
            self.run_installer(WARTHOG_SECRET_ORIGIN='Bad Origin!')


if __name__ == '__main__':
    unittest.main()
