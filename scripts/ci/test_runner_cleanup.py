import datetime
import unittest
from cleanup_runners import expired_group, detached_subnet, PREFIX

class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime(2026, 11, 10, 12, tzinfo=datetime.timezone.utc)
        self.name = 'rg-warthog-runner-202611101200'
        self.group = {'name': self.name, 'tags': {'application': 'warthog', 'purpose': 'ephemeral-runner', 'lease_id': '202611101200', 'expires_at': '2026-11-10T11:59:00Z'}}

    def test_only_expired_labelled_runner_groups_are_selected(self):
        self.assertTrue(expired_group(self.group, self.now))
        for name in ['rg-warthog-prod-aue', 'rg-warthog-delivery-aue', 'rg-warthog-runner-other']:
            self.assertFalse(expired_group(dict(self.group, name=name), self.now))
        for value in ['2026-11-10T13:00:00Z', 'invalid', '2026-11-10T10:00:00']:
            tags = dict(self.group['tags'], expires_at=value)
            self.assertFalse(expired_group(dict(self.group, tags=tags), self.now))
        self.assertFalse(expired_group(dict(self.group, tags={}), self.now))

    def test_detach_preserves_network_and_does_not_touch_another_lease(self):
        props = {'addressPrefix': '10.64.3.0/27', 'serviceEndpoints': [{'service': 'Microsoft.KeyVault'}], 'natGateway': {'id': PREFIX+self.name+'/providers/Microsoft.Network/natGateways/runner-egress'}, 'provisioningState': 'Succeeded'}
        result = detached_subnet({'properties': props}, self.name)
        self.assertEqual(result, {'properties': {'addressPrefix': '10.64.3.0/27', 'serviceEndpoints': [{'service': 'Microsoft.KeyVault'}]}})
        self.assertIn('natGateway', props)
        self.assertIsNone(detached_subnet({'properties': props}, 'rg-warthog-runner-202611100000'))
        self.assertIsNone(detached_subnet({'properties': {'addressPrefix': '10.64.3.0/27'}}, self.name))

if __name__ == '__main__':
    unittest.main()
