"""Offline checks for reusing a passing full-checks result; no network or Docker."""
from pathlib import Path
import re
import unittest
import urllib.error

import reuse_checks

REPO = "Orlev01/warthog"
TREE = "a" * 40
BASE = "node:22-bookworm-slim@sha256:" + "b" * 64
MAIN, PR_HEAD, PREVIOUS = "c" * 40, "d" * 40, "e" * 40
WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


def env(event="push", base_input=""):
    return {"GITHUB_EVENT_NAME": event, "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": MAIN, "NODE_BASE_INPUT": base_input}


def api(runs_by_sha, jobs_by_run):
    """A fake GitHub API: the main commit's parents, each workflow's runs per head commit, jobs per run."""
    calls = []

    def get(path):
        calls.append(path)
        if path == f"/repos/{REPO}/commits/{MAIN}":
            return {"parents": [{"sha": PREVIOUS}, {"sha": PR_HEAD}]}
        match = re.fullmatch(rf"/repos/{REPO}/actions/workflows/([a-z-]+\.yml)/runs\?head_sha=([a-f0-9]+)&per_page=100", path)
        if match:
            workflow, sha = match.groups()
            return {"workflow_runs": [r for r in runs_by_sha.get(sha, []) if r["head_sha"] == sha and r["path"] == ".github/workflows/" + workflow]}
        match = re.fullmatch(rf"/repos/{REPO}/actions/runs/(\d+)/jobs\?per_page=100", path)
        if match:
            return {"jobs": jobs_by_run.get(int(match.group(1)), [])}
        raise AssertionError("unexpected API call " + path)
    get.calls = calls
    return get


def run(run_id, sha=PR_HEAD, event=None, branch=None, path=".github/workflows/ci.yml", repository=REPO):
    """A run as GitHub lists it. By default a pull request's run on the PR head, or a run on main."""
    on_main = sha != PR_HEAD
    return {"id": run_id, "head_sha": sha, "path": path, "head_repository": {"full_name": repository},
            "event": event or ("push" if on_main else "pull_request"), "head_branch": branch or ("main" if on_main else "claude/feature"),
            "html_url": f"https://github.com/{REPO}/actions/runs/{run_id}"}


def passed(tree=TREE, base=BASE, conclusion="success", prefix=""):
    return {"name": prefix + reuse_checks.marker(tree, base), "conclusion": conclusion}


def pinned(_reference):
    return "sha256:" + "b" * 64


class ReuseTests(unittest.TestCase):
    def test_pull_requests_and_manual_runs_always_check_in_full(self):
        get = api({PR_HEAD: [run(1)]}, {1: [passed()]})
        for event in ["pull_request", "workflow_dispatch"]:
            with self.subTest(event=event):
                reuse, base, _ = reuse_checks.decide(env(event), TREE, get, pinned)
                self.assertFalse(reuse)
                self.assertEqual(base, BASE, "every shard still checks on one pinned base")
        self.assertEqual(get.calls, [], "no earlier result is even looked for")

    def test_a_merge_reuses_its_pull_request_result_for_the_identical_tree_and_base(self):
        get = api({PR_HEAD: [run(7)]}, {7: [passed()]})
        reuse, base, note = reuse_checks.decide(env("push"), TREE, get, pinned)
        self.assertTrue(reuse)
        self.assertEqual(base, BASE)
        self.assertIn("/actions/runs/7", note)

    def test_an_image_build_reuses_only_on_its_own_pinned_base(self):
        get = api({MAIN: [run(8, MAIN, "workflow_dispatch", path=".github/workflows/azure-image.yml")]}, {8: [passed(prefix="checks / ")]})
        self.assertTrue(reuse_checks.decide(env("workflow_dispatch", BASE), TREE, get, pinned)[0])
        other = "node:22-bookworm-slim@sha256:" + "f" * 64
        self.assertFalse(reuse_checks.decide(env("workflow_dispatch", other), TREE, get, pinned)[0])
        with self.assertRaises(RuntimeError):
            reuse_checks.decide(env("workflow_dispatch", "node:22-bookworm-slim"), TREE, get, pinned)

    def test_anything_short_of_an_identical_passing_result_checks_in_full(self):
        cases = {
            "another tree": ({PR_HEAD: [run(1)]}, {1: [passed(tree="9" * 40)]}),
            "another base": ({PR_HEAD: [run(1)]}, {1: [passed(base="node:22-bookworm-slim@sha256:" + "f" * 64)]}),
            "the checks failed": ({PR_HEAD: [run(1)]}, {1: [passed(conclusion="failure")]}),
            "the checks were skipped": ({PR_HEAD: [run(1)]}, {1: [passed(conclusion="skipped")]}),
            "another workflow": ({PR_HEAD: [run(1, path=".github/workflows/other.yml")]}, {1: [passed()]}),
            "another repository": ({PR_HEAD: [run(1, repository="someone/fork")]}, {1: [passed()]}),
            # A pull request from main into another branch runs that branch's workflow on main's commit.
            "a pull request run on this commit": ({MAIN: [run(1, MAIN, "pull_request", "claude/feature")]}, {1: [passed()]}),
            "a pull request run from main": ({PR_HEAD: [run(1, branch="main")]}, {1: [passed()]}),
            "a push run off main": ({MAIN: [run(1, MAIN, "push", "claude/feature")]}, {1: [passed()]}),
            "a run on the first parent": ({PREVIOUS: [run(1, PREVIOUS), run(2, PREVIOUS, "pull_request", "claude/feature")]}, {1: [passed()], 2: [passed()]}),
            "a push run on the pull request head": ({PR_HEAD: [run(1, event="push", branch="main")]}, {1: [passed()]}),
            "a name that only contains the marker": ({PR_HEAD: [run(1)]}, {1: [{"name": "x" + reuse_checks.marker(TREE, BASE), "conclusion": "success"}]}),
            "no earlier run": ({}, {}),
        }
        for name, (runs, jobs) in cases.items():
            with self.subTest(name):
                self.assertFalse(reuse_checks.decide(env("push"), TREE, api(runs, jobs), pinned)[0])

    def test_an_unreadable_history_or_unpinnable_base_checks_in_full(self):
        def broken(_path):
            raise urllib.error.URLError("offline")
        reuse, base, note = reuse_checks.decide(env("push"), TREE, broken, pinned)
        self.assertFalse(reuse)
        self.assertEqual(base, BASE)
        self.assertIn("URLError", note)
        for digest in [None, "latest", "sha256:short"]:
            with self.subTest(digest=digest):
                reuse, base, _ = reuse_checks.decide(env("push"), TREE, api({PR_HEAD: [run(1)]}, {1: [passed()]}), lambda _r: digest)
                self.assertFalse(reuse)
                self.assertEqual(base, "node:22-bookworm-slim")


class WorkflowWiringTests(unittest.TestCase):
    def setUp(self):
        self.ci = (WORKFLOWS / "ci.yml").read_text()
        self.jobs = self.ci[self.ci.index("\njobs:\n"):]

    def job(self, name):
        match = re.search(rf"^  {re.escape(name)}:\n((?:    .*\n|\n)*)", self.jobs, re.M)
        self.assertIsNotNone(match, f"ci.yml has no {name} job")
        return match.group(1)

    def test_the_final_job_is_named_exactly_as_the_evidence_is_looked_for(self):
        final = self.job("passed")
        expected = reuse_checks.marker("${{ needs.plan.outputs.tree }}", "${{ needs.plan.outputs.base }}")
        self.assertIn(f"    name: {expected}\n", final)
        self.assertIn("    needs: [plan, delivery-safety, infrastructure-schema, linux-postgres]\n", final)
        self.assertIn("    if: needs.plan.outputs.reuse != 'true'\n", final)
        self.assertNotRegex(final, r"always\(\)|failure\(\)|cancelled\(\)", "it must run only when every check passed")

    def test_every_check_is_skipped_only_by_a_reuse_decision_and_uses_the_pinned_base(self):
        jobs = re.findall(r"^  ([a-z0-9-]+):\n", self.jobs, re.M)
        self.assertEqual(jobs, ["plan", "delivery-safety", "infrastructure-schema", "linux-postgres", "passed"])
        for name in ["delivery-safety", "infrastructure-schema", "linux-postgres"]:
            with self.subTest(name):
                body = self.job(name)
                self.assertIn("    needs: plan\n", body)
                self.assertIn("    if: needs.plan.outputs.reuse != 'true'\n", body)
        self.assertIn("NODE_BASE_IMAGE: ${{ needs.plan.outputs.base }}", self.job("linux-postgres"))

    def test_ci_stays_read_only(self):
        grants = re.findall(r"^\s+(\w[\w-]*): (read|write)$", self.ci, re.M)
        self.assertTrue(grants)
        self.assertTrue(all(level == "read" for _, level in grants), grants)
        self.assertNotRegex(self.ci, r"write-all|:\s*write\b", "no write grant in any form")

    def test_the_image_build_checks_its_approval_before_the_long_checks(self):
        image = (WORKFLOWS / "azure-image.yml").read_text()
        gate = image[image.index("  gate:"):image.index("  checks:")]
        self.assertIn("from common import gate; gate()", gate)
        self.assertIn("APPROVAL_REFERENCE: ${{ inputs.approval_reference }}", gate)
        checks = image[image.index("  checks:"):image.index("  publish:")]
        self.assertIn("needs: gate", checks)
        self.assertIn("actions: read", checks)


if __name__ == "__main__":
    unittest.main()
