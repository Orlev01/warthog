#!/usr/bin/env python3
"""Offline Azure launch estimate; reads public retail rates, never calls Azure."""
import argparse
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def estimate(model, hours=Decimal(730), active_fraction=Decimal(1)):
    """Use full paid rates: shared free grants/credits are not guaranteed savings."""
    if not hours.is_finite() or not 0 < hours <= 744:
        raise ValueError("Hours must be positive and at most 744")
    if not active_fraction.is_finite() or not 0 <= active_fraction <= 1:
        raise ValueError("Active fraction must be between zero and one")
    a = model["assumptions"]
    r = {key: Decimal(str(value["aud"])) for key, value in model["rates"].items()}
    days, seconds = hours / 24, hours * 3600
    active_cpu = a["app_vcpu"] * seconds * active_fraction
    idle_cpu = a["app_vcpu"] * seconds * (1 - active_fraction)
    items = {
        "PostgreSQL compute": hours * r["pg_compute_hour"],
        "PostgreSQL 32 GiB disk": a["pg_storage_gib"] * r["pg_storage_gib_month"],
        "PostgreSQL extra backup allowance": a["pg_extra_backup_gib"] * r["pg_backup_gib_month"],
        "Container App compute and requests": (
            active_cpu * r["aca_active_vcpu_second"] + idle_cpu * r["aca_idle_vcpu_second"]
            + a["app_memory_gib"] * seconds * r["aca_memory_gib_second"]
            + a["app_requests_million"] * r["aca_requests_million"]),
        "ACA managed load balancer and two public IPs": (
            hours * (r["lb_hour"] + 2 * r["ip_hour"])
            + a["lb_processed_gb"] * r["lb_processed_gb"]),
        "ACR Basic": days * r["acr_day"] + a["acr_extra_storage_gb"] * r["acr_extra_gb_month"],
        "Premium Key Vault: two active HSM versions and operations": (
            a["hsm_active_versions"] * r["hsm_version_month"]
            + a["key_operations"] / 10000 * r["key_operations_10k"]
            + a["secret_operations"] / 10000 * r["secret_operations_10k"]),
        "Logs at daily allowance": days * a["log_gb_per_day"] * r["logs_gb"],
        "Receipt/state blobs and operations": (
            a["blob_stored_gb"] * r["blob_gb_month"]
            + a["blob_writes"] / 10000 * r["blob_writes_10k"]
            + a["blob_reads"] / 10000 * r["blob_reads_10k"]
            + a["blob_lists"] / 10000 * r["blob_lists_10k"]),
        "Private DNS zone and queries": r["dns_zone_month"] + a["dns_queries_million"] * r["dns_queries_million"],
        "Internet and inter-zone transfer allowance": (
            a["internet_egress_gb"] * r["egress_gb"]
            + a["interzone_gb"] * 2 * r["interzone_gb"]),
        "Ephemeral private VM runner, NAT, IP and disk": (
            a["runner_compute_hours"] * r["runner_vm_hour"]
            + a["runner_network_hours"] * (r["nat_hour"] + r["ip_hour"])
            + a["runner_network_gb"] * r["nat_gb"]
            + a["runner_disk_hours"] / 730 * r["runner_disk_month"]
            + a["runner_disk_operations_allowance_aud"]),
        "Operational alert allowance (not yet metered)": a["operational_alert_allowance_aud"],
    }
    total = sum(items.values())
    return items, total


def money(value):
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def check_profile(model, profile, budget):
    assumptions = model["assumptions"]
    expected = {
        "PostgreSQL compute": (profile["postgres"]["sku"], model["configuration"]["postgres_sku"]),
        "PostgreSQL storage performance": (profile["postgres"]["storage_tier"], model["configuration"]["postgres_storage_tier"]),
        "PostgreSQL storage size": (profile["postgres"]["storage_mb"], assumptions["pg_storage_gib"] * 1024),
        "Log allowance": (profile["log_daily_cap_gb"], assumptions["log_gb_per_day"]),
        "Monthly alert": (profile["monthly_azure_budget_aud"], budget),
        "Example approval": (profile["provisioning_approved"], False),
    }
    for label, (actual, wanted) in expected.items():
        if actual != wanted:
            raise ValueError(f"{label} differs between launch profile and estimate; review both before changing the alert")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=Decimal, default=Decimal(730))
    parser.add_argument("--active-fraction", type=Decimal, default=Decimal(1))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--check-profile", action="store_true")
    args = parser.parse_args()
    model = json.loads((HERE / "launch-model.json").read_text(), parse_float=Decimal, parse_int=Decimal)
    items, total = estimate(model, args.hours, args.active_fraction)
    _, long_month = estimate(model, Decimal(744), Decimal(1))
    budget = (long_month / 10).quantize(Decimal(1), rounding=ROUND_CEILING) * 10
    if args.check_profile:
        profile = json.loads((HERE.parent / "profiles/launch.tfvars.example.json").read_text(), parse_float=Decimal, parse_int=Decimal)
        check_profile(model, profile, budget)
    result = {"currency": "AUD", "basis": "gross Azure usage, before credits and tax",
              "hours": str(args.hours), "active_fraction": str(args.active_fraction),
              "items": {key: money(value) for key, value in items.items()},
              "total": money(total), "full_active_31_day_total": money(long_month),
              "recommended_monthly_alert": money(budget)}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("| Component | AUD/month |\n| --- | ---: |")
        for key, value in items.items():
            print(f"| {key} | {money(value)} |")
        print(f"| **Total** | **{money(total)}** |")
        print(f"\n31-day full-active allowance: A${money(long_month)}; monthly alert: A${money(budget)}.")
        print("Estimate only; excludes credits, tax and non-Azure services. No cloud action performed.")


if __name__ == "__main__":
    main()
