"""Decide whether the full release checks must run, or already passed for this exact source.

Pull requests and manual runs always run the full checks. A push to main and an image build
(the reusable call, which pins the Node base) skip them only when the same git tree, every file
including these workflows, already passed on the same pinned Node base. The evidence is the
final job of a full run, which runs only when every check passed and is named after the tree and
base it checked (`marker`). It is looked for in runs of ci.yml or azure-image.yml on this commit
or one of its parents, which is where a pull request's checks run. Anything uncertain (an API
error, a base that cannot be resolved, no matching job) runs the full checks.

Read-only: it needs `actions: read` and `contents: read`, and never writes anything.
"""
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request

DEFAULT_BASE = "node:22-bookworm-slim"
PINNED_BASE = r"node:22-bookworm-slim@sha256:[a-f0-9]{64}"
EVIDENCE_WORKFLOWS = {".github/workflows/ci.yml", ".github/workflows/azure-image.yml"}
API = "https://api.github.com"


def marker(tree, base):
    return f"Full checks passed for tree {tree} on {base}"


def may_reuse(event, base_input):
    """Pull requests and manual CI runs always check in full; pushes and image builds may reuse."""
    return event == "push" or (event == "workflow_dispatch" and bool(base_input))


def pinned_base(base_input, resolve):
    """The pinned base this run checks with: the image build's input, or the default tag resolved now."""
    if base_input:
        if not re.fullmatch(PINNED_BASE, base_input):
            raise RuntimeError("Invalid setting: node_base_image")
        return base_input
    digest = resolve(DEFAULT_BASE)
    return f"{DEFAULT_BASE}@{digest}" if digest and re.fullmatch(r"sha256:[a-f0-9]{64}", digest) else None


def docker_digest(reference):
    try:
        output = subprocess.run(["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"],
                                capture_output=True, text=True, timeout=120, check=True).stdout
        return json.loads(output).get("digest")
    except Exception:
        return None


def evidence(get, repository, sha, tree, base):
    """The URL of a run whose final full-checks job passed for this tree and base, or None."""
    mark = marker(tree, base)
    commit = get(f"/repos/{repository}/commits/{sha}")
    candidates = [sha] + [parent["sha"] for parent in commit.get("parents", [])]
    for candidate in candidates:
        query = urllib.parse.urlencode({"head_sha": candidate, "per_page": 100})
        for run in get(f"/repos/{repository}/actions/runs?{query}").get("workflow_runs", []):
            if run.get("path") not in EVIDENCE_WORKFLOWS or (run.get("head_repository") or {}).get("full_name") != repository:
                continue
            jobs = get(f"/repos/{repository}/actions/runs/{int(run['id'])}/jobs?per_page=100").get("jobs", [])
            if any(job.get("conclusion") == "success" and (job.get("name") == mark or job.get("name", "").endswith(" / " + mark))
                   for job in jobs):
                return run.get("html_url") or str(run["id"])
    return None


def github_get(token):
    def get(path):
        request = urllib.request.Request(API + path, headers={
            "Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    return get


def decide(env, tree, get, resolve):
    """(reuse, base, note) for this run."""
    base_input = env.get("NODE_BASE_INPUT", "")
    base = pinned_base(base_input, resolve)
    if base is None:
        return False, DEFAULT_BASE, "The Node base could not be pinned, so the full checks run on the tag."
    if not may_reuse(env.get("GITHUB_EVENT_NAME", ""), base_input):
        return False, base, "Pull requests and manual runs always run the full checks."
    try:
        found = evidence(get, env["GITHUB_REPOSITORY"], env["GITHUB_SHA"], tree, base)
    except Exception as error:
        return False, base, f"Earlier results could not be read ({type(error).__name__}), so the full checks run."
    if found:
        return True, base, f"Tree {tree} already passed every check on {base}: {found}"
    return False, base, f"Tree {tree} has not passed on {base} yet, so the full checks run."


def main():
    env = os.environ
    tree = subprocess.run(["git", "rev-parse", "HEAD^{tree}"], capture_output=True, text=True, check=True).stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{40}", tree):
        raise SystemExit("Could not read the checked-out tree")
    reuse, base, note = decide(env, tree, github_get(env.get("GITHUB_TOKEN", "")), docker_digest)
    print(note)
    with open(env["GITHUB_OUTPUT"], "a") as stream:
        stream.write(f"reuse={'true' if reuse else 'false'}\ntree={tree}\nbase={base}\n")
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(note + "\n")


if __name__ == "__main__":
    main()
