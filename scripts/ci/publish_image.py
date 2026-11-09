"""Publish only after the reusable clean Linux/PG16 workflow and environment review."""
import json
import os
import tempfile

from common import account, command, gate, main_guard, require, setting, summary


def run():
    gate()
    account()
    base = setting("NODE_BASE_IMAGE", r"node:22-bookworm-slim@sha256:[a-f0-9]{64}")
    registry = setting("ACR_NAME", r"[a-z0-9]{5,50}")
    repository = setting("ACR_REPOSITORY", r"warthog")
    sha = setting("GITHUB_SHA", r"[a-f0-9]{40}")
    tag = "git-" + sha + "-" + setting("GITHUB_RUN_ID", r"[0-9]+") + "-" + setting("GITHUB_RUN_ATTEMPT", r"[0-9]+")
    server = registry + ".azurecr.io"
    image = f"{server}/{repository}:{tag}"
    # A fresh Docker config contains only this short-lived ACR login.
    with tempfile.TemporaryDirectory(prefix="warthog-acr-") as directory:
        os.environ["DOCKER_CONFIG"] = directory
        command(["az", "acr", "login", "--name", registry, "--only-show-errors", "-o", "none"])
        command(["docker", "build", "--pull", "--platform", "linux/amd64", "--target", "runtime",
                 "--build-arg", "NODE_BASE_IMAGE=" + base,
                 "--label", "org.opencontainers.image.source=https://github.com/Orlev01/warthog",
                 "--label", "org.opencontainers.image.revision=" + sha,
                 "--label", "org.opencontainers.image.base.name=" + base,
                 "--label", "io.warthog.verified=linux-pg16", "--tag", image, "."], timeout=1500)
        metadata = json.loads(command(["docker", "image", "inspect", image]))[0]
        require(metadata["Os"] == "linux" and metadata["Architecture"] == "amd64"
                and metadata["Config"]["User"] == "node", "Runtime platform or user differs")
        command(["docker", "push", image], timeout=900)
        result = json.loads(command(["az", "acr", "repository", "show", "--name", registry,
                                     "--image", f"{repository}:{tag}", "--only-show-errors", "-o", "json"]))
        image_digest = result.get("digest", "")
        import re
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_digest), "Registry did not return an immutable digest")
        summary(f"Candidate `{server}/{repository}@{image_digest}` from `{sha}`. "
                "Clean Linux/PG16 checks passed using the pinned base. No application was deployed.")


if __name__ == "__main__":
    main_guard(run)
