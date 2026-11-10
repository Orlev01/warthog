#!/usr/bin/env bash
# Runs only on a fresh, identity-free Ubuntu 24.04 Warthog VM via Azure Run Command.
# No application secrets, PAT or runner registration token belongs in this script.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
umask 077
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git python3 docker.io postgresql-client-16 jq
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://packages.microsoft.com/keys/microsoft.asc -o /tmp/warthog-microsoft.asc
gpg --dearmor --yes --output /etc/apt/keyrings/microsoft.gpg /tmp/warthog-microsoft.asc
chmod 0644 /etc/apt/keyrings/microsoft.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main' > /etc/apt/sources.list.d/azure-cli.list
apt-get update -qq
apt-get install -y -qq azure-cli
systemctl enable --now docker
usermod -aG docker runner
install -d -o runner -g runner -m 0700 /home/runner/.postgresql /home/runner/actions-runner
install -o runner -g runner -m 0600 /etc/ssl/certs/ca-certificates.crt /home/runner/.postgresql/root.crt
# Azure Run Command protected parameters supply reviewed public release coordinates.
# Download only the official runner release asset; verify the independently fetched
# release SHA-256 before executing any part of the archive.
[[ "$RUNNER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$RUNNER_SHA256" =~ ^[a-f0-9]{64}$ ]]
curl --fail --silent --show-error --location "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" -o /tmp/warthog-runner.tar.gz
printf '%s  %s\n' "$RUNNER_SHA256" /tmp/warthog-runner.tar.gz | sha256sum --check --status
tar xzf /tmp/warthog-runner.tar.gz -C /home/runner/actions-runner
chown -R runner:runner /home/runner/actions-runner
runuser -u runner -- az config set extension.use_dynamic_install=no --only-show-errors
# These production operations are in Azure CLI core. Do not install a preview
# extension merely because the extension index advertises one as latest.
for command in 'containerapp list' 'containerapp show' 'containerapp revision list' 'containerapp replica list' 'containerapp revision deactivate' 'containerapp revision copy' 'containerapp ingress traffic set'; do
  read -r -a words <<< "$command"
  runuser -u runner -- az "${words[@]}" --help >/dev/null
done
rm -f /tmp/warthog-runner.tar.gz /tmp/warthog-microsoft.asc
runuser -u runner -- docker info --format 'Docker={{.ServerVersion}}'
runuser -u runner -- az version
psql --version
python3 --version
git --version
# Private Key Vault network/TLS reachability, without retrieving a secret.
runuser -u runner -- python3 - <<'PY'
import urllib.request, urllib.error
try:
    urllib.request.urlopen('https://kv-warthog-aue-e854.vault.azure.net/secrets?api-version=7.4', timeout=30)
except urllib.error.HTTPError as e:
    assert e.code == 401, f'Expected authenticated Key Vault endpoint, received {e.code}'
print('Key Vault TLS endpoint reached; authentication required as expected.')
PY
