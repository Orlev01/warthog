"""Offline checks for cost omissions, activity sensitivity and invalid inputs."""
from decimal import Decimal
import json
import unittest
import copy

from estimate import HERE, estimate, money, check_profile


class EstimateTests(unittest.TestCase):
    def setUp(self):
        self.model = json.loads((HERE / "launch-model.json").read_text(), parse_float=Decimal, parse_int=Decimal)

    def test_continuous_app_charged_even_when_no_requests(self):
        self.model["assumptions"]["app_requests_million"] = Decimal(0)
        items, _ = estimate(self.model, Decimal(24), Decimal(1))
        # 43,200 vCPU-seconds + 86,400 GiB-seconds at the converted regional rates.
        self.assertEqual(money(items["Container App compute and requests"]), "2.58")

    def test_idle_only_reduces_cpu_not_memory_or_fixed_foundation(self):
        active, active_total = estimate(self.model)
        idle, idle_total = estimate(self.model, active_fraction=Decimal(0))
        self.assertGreater(active_total, idle_total)
        self.assertGreater(idle["Container App compute and requests"], Decimal(0))
        for key in active:
            if key != "Container App compute and requests":
                self.assertEqual(active[key], idle[key])

    def test_month_length_does_not_multiply_key_versions_or_oneoff_usage(self):
        normal, normal_total = estimate(self.model)
        long, long_total = estimate(self.model, Decimal(744))
        self.assertGreater(long_total, normal_total)
        self.assertEqual(normal["Premium Key Vault: two active HSM versions and operations"],
                         long["Premium Key Vault: two active HSM versions and operations"])
        self.assertGreater(long["PostgreSQL compute"], normal["PostgreSQL compute"])

    def test_rejects_negative_nonfinite_and_impossible_scenarios(self):
        for hours in [Decimal(0), Decimal(-1), Decimal(745), Decimal('NaN')]:
            with self.subTest(hours=str(hours)), self.assertRaises(ValueError):
                estimate(self.model, hours)
        for active in [Decimal(-1), Decimal(2), Decimal('Infinity')]:
            with self.subTest(active=str(active)), self.assertRaises(ValueError):
                estimate(self.model, active_fraction=active)

    def test_sizing_or_alert_changes_require_updated_cost_review(self):
        profile = json.loads((HERE.parent / "profiles/launch.tfvars.example.json").read_text(), parse_float=Decimal, parse_int=Decimal)
        check_profile(self.model, profile, Decimal(440))
        for field, value in [("monthly_azure_budget_aud", 100), ("log_daily_cap_gb", 1), ("provisioning_approved", True)]:
            changed = copy.deepcopy(profile)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_profile(self.model, changed, Decimal(440))
        changed = copy.deepcopy(profile)
        changed["postgres"]["storage_mb"] = 65536
        with self.assertRaises(ValueError):
            check_profile(self.model, changed, Decimal(440))


if __name__ == "__main__":
    unittest.main()
