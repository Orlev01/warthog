#!/usr/bin/env python3
"""Operator-controlled, short-lived private runner. All private inputs stay local.

Commands: plan, apply, prepare, register, destroy. Never dispatches/approves a
release. Run `destroy` in a finally block; independent hourly cleanup handles an
expired lease if the operator process disappears. The VM has no Azure identity.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SUB = 'e854f594-274f-4051-841b-78df7655d73c'
TENANT = '72277873-e056-4612-9b1c-7ad58e02fcf3'
REPO = 'Orlev01/warthog'
sys.path.insert(0, str(ROOT/'scripts/ci'))
from runner_lock import runner_lock
from cleanup_runners import SUBNET, detached_subnet


LEASE_CHECK = lambda: None
PRIVATE_DIRECTORY = None


def run(args, *, env=None, accepted=(0,), input=None):
    LEASE_CHECK()
    process = subprocess.Popen(args, env=env, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        first = True
        while True:
            try:
                stdout, stderr = process.communicate(input=input if first else None, timeout=2)
                break
            except subprocess.TimeoutExpired:
                first = False
                LEASE_CHECK()
        LEASE_CHECK()
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:stream.close()
        raise
    if process.returncode not in accepted:
        if PRIVATE_DIRECTORY:
            (PRIVATE_DIRECTORY/'last-command-error.log').write_text(stdout+'\n'+stderr)
        raise RuntimeError(f'{args[0]} failed (exit {process.returncode}); output withheld to protect credentials')
    return stdout


def github(path, method='GET', body=None):
    clean = {k:v for k,v in os.environ.items() if not k.startswith(('GH_', 'GITHUB_')) and k != 'GITHUB_ACCESS_TOKEN'}
    token = run(['/opt/homebrew/bin/gh', 'auth', 'token', '--hostname', 'github.com', '--user', 'Orlev01'], env=clean).strip()
    def request(path, method='GET', body=None):
        req = urllib.request.Request('https://api.github.com/'+path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'})
        with urllib.request.urlopen(req) as response:
            payload = response.read()
            return json.loads(payload) if payload else {}
    if request('user')['login'] != 'Orlev01':
        raise RuntimeError('Personal Orlev01 credential required')
    return request(path, method, body)


def azure(path, method='GET', body=None):
    LEASE_CHECK()
    token = json.loads(run(['az', 'account', 'get-access-token', '--subscription', SUB, '-o', 'json']))['accessToken']
    req = urllib.request.Request('https://management.azure.com'+path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+token, 'Content-Type':'application/json'})
    LEASE_CHECK()
    with urllib.request.urlopen(req, timeout=35) as response:
        payload = response.read()
        return json.loads(payload) if payload else {}


def vm_command(directory, name, script, protected):
    config = json.loads((directory/'approved.tfvars.json').read_text())
    group = 'rg-warthog-runner-'+config['lease_id']
    vm = f'/subscriptions/{SUB}/resourceGroups/{group}/providers/Microsoft.Compute/virtualMachines/warthog-runner'
    path = vm+'/runCommands/'+name+'?api-version=2024-07-01'
    body = {'location':'australiaeast', 'properties':{'source':{'script':script}, 'protectedParameters':[{'name':k, 'value':v} for k,v in protected.items()], 'timeoutInSeconds':2400, 'asyncExecution':True, 'treatFailureAsDeploymentFailure':True}}
    azure(path, 'PUT', body)
    deadline = time.monotonic()+2500
    while time.monotonic() < deadline:
        status = azure(path+'&$expand=instanceView')
        state = status.get('properties',{}).get('instanceView',{})
        if state.get('executionState') in ('Succeeded', 'Failed', 'TimedOut', 'Canceled'):
            # Output may include operational evidence: private file, never stdout.
            (directory/(name+'-result.json')).write_text(json.dumps(status))
            if state.get('executionState') != 'Succeeded' or state.get('exitCode', 0) != 0:
                raise RuntimeError('Private VM command failed; inspect protected evidence')
            return status
        time.sleep(10)
    raise RuntimeError('Private VM command timed out; destroy the runner')


def operate(check_lease):
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['plan','apply','prepare','register','destroy'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--reviewed-plan-sha256')
    parser.add_argument('--run-id')
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_relative_to(ROOT/'.delivery'):
        raise RuntimeError('Private runner files must be inside ignored .delivery/')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    global PRIVATE_DIRECTORY
    PRIVATE_DIRECTORY = directory
    config = json.loads((directory/'approved.tfvars.json').read_text())
    if not re.fullmatch('[0-9]{10,14}', config['lease_id']):
        raise RuntimeError('Invalid lease ID')
    expiry = datetime.datetime.fromisoformat(config['expires_at'].replace('Z','+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    if args.operation != 'destroy' and not (now < expiry <= now+datetime.timedelta(hours=4)):
        raise RuntimeError('Lease must expire within four hours')
    account = json.loads(run(['az','account','show','--subscription',SUB,'-o','json']))
    if account['id'] != SUB or account['tenantId'] != TENANT or account['user']['name'].lower() != 'orlev94@outlook.com':
        raise RuntimeError('Personal Warthog operator session required')
    env = {k:v for k,v in os.environ.items() if not k.startswith(('ARM_','TF_','TFC_')) and k!='LOG_SENSITIVE_DATA'}
    env.update(ARM_USE_CLI='true', ARM_USE_OIDC='false', ARM_USE_MSI='false', ARM_SUBSCRIPTION_ID=SUB, ARM_TENANT_ID=TENANT, TF_DATA_DIR=str(directory/'terraform-data'), TF_INPUT='false')
    tf = ['terraform','-chdir='+str(ROOT/'infra/runner')]
    if args.operation in ('plan','apply','destroy'):
        run(tf+['init','-reconfigure','-input=false','-lockfile=readonly','-backend-config=path='+str(directory/'runner.tfstate')],env=env)
    if args.operation in ('plan', 'apply'):
        check_lease()
        subnet = azure(SUBNET+'?api-version=2024-05-01')
        nat = (subnet['properties'].get('natGateway') or {}).get('id')
        expected = f'/subscriptions/{SUB}/resourceGroups/rg-warthog-runner-{config["lease_id"]}/providers/Microsoft.Network/natGateways/runner-egress'
        if nat and nat.lower() != expected.lower():
            raise RuntimeError('Another runner owns the private subnet; refuse overlapping leases')
    if args.operation == 'plan':
        output = run(tf+['plan','-input=false','-detailed-exitcode','-var-file='+str(directory/'approved.tfvars.json'),'-out='+str(directory/'runner.tfplan')],env=env,accepted=(0,2))
        (directory/'plan.log').write_text(output)
        plan = json.loads(run(tf+['show','-json',str(directory/'runner.tfplan')],env=env))
        (directory/'plan.json').write_text(json.dumps(plan))
        if any('delete' in r['change']['actions'] for r in plan.get('resource_changes',[])):
            raise RuntimeError('Replacement/deletion requires a separate teardown')
        print('Runner plan SHA-256:',hashlib.sha256((directory/'runner.tfplan').read_bytes()).hexdigest())
    elif args.operation == 'apply':
        digest = hashlib.sha256((directory/'runner.tfplan').read_bytes()).hexdigest()
        if digest != args.reviewed_plan_sha256:
            raise RuntimeError('Supply SHA-256 of the inspected saved runner plan')
        (directory/'apply.log').write_text(run(tf+['apply','-input=false',str(directory/'runner.tfplan')],env=env))
        print('Private runner lease created; prepare and verify it before registering.')
    elif args.operation == 'prepare':
        release = json.loads((directory/'runner-release.json').read_text())
        vm_command(directory, 'prepare', (ROOT/'scripts/delivery/prepare-runner.sh').read_text(), {'RUNNER_VERSION':release['version'],'RUNNER_SHA256':release['sha256']})
        print('Private runner tooling and vault TLS reachability verified.')
    elif args.operation == 'register':
        if args.run_id:
            if args.run_id != config['lease_id']:
                raise RuntimeError('Lease ID must match approved release run ID')
            job = github(f'repos/{REPO}/actions/runs/{args.run_id}')
            if job['event'] != 'workflow_dispatch' or job['head_branch'] != 'main' or job['path'] != '.github/workflows/azure-release.yml' or job['repository']['full_name'] != REPO:
                raise RuntimeError('Only this repository manual main release can use a private runner')
        else:
            print('Connectivity rehearsal: unique lease label cannot match a release job.')
        body = {'name':'warthog-'+config['lease_id'], 'runner_group_id':1, 'labels':['self-hosted','linux','x64','warthog-production','warthog-run-'+config['lease_id']], 'work_folder':'_work'}
        result = github(f'repos/{REPO}/actions/runners/generate-jitconfig','POST',body)
        (directory/'github-runner.json').write_text(json.dumps(result['runner']))
        script = '''#!/usr/bin/env bash
set -euo pipefail
umask 077
python3 - <<'PY'
import os,subprocess
with open('/var/log/warthog-runner.log','ab',buffering=0) as out:
    subprocess.Popen(['runuser','-u','runner','--','env','HOME=/home/runner','bash','-c','cd /home/runner/actions-runner; exec ./run.sh --jitconfig "$WARTHOG_JIT"'],env=dict(os.environ),stdout=out,stderr=out,start_new_session=True)
PY
'''
        vm_command(directory,'register',script,{'WARTHOG_JIT':result['encoded_jit_config']})
        deadline = time.monotonic()+120
        while time.monotonic()<deadline:
            state = github(f'repos/{REPO}/actions/runners/{result["runner"]["id"]}')
            if state['status']=='online':
                print('One-job private runner is online with its unique run label.')
                return
            time.sleep(5)
        raise RuntimeError('Runner not online; destroy lease and inspect private logs')
    elif args.operation == 'destroy':
        check_lease()
        subnet = azure(SUBNET+'?api-version=2024-05-01')
        body = detached_subnet(subnet, 'rg-warthog-runner-'+config['lease_id'])
        if body:
            # The shared Blob lease serializes this with new leases and the reaper.
            azure(SUBNET+'?api-version=2024-05-01', 'PUT', body)
        # AzureRM refresh/delete otherwise follows ANY current association, even
        # a newer lease's NAT. Never allow Terraform to destroy this shared link.
        addresses = run(tf+['state','list'],env=env).splitlines()
        if 'azurerm_subnet_nat_gateway_association.runner' in addresses:
            run(tf+['state','rm','azurerm_subnet_nat_gateway_association.runner'],env=env)
        check_lease()
        deregistration_failed = False
        try:
            if (directory/'github-runner.json').exists():
                runner = json.loads((directory/'github-runner.json').read_text())
                try:github(f'repos/{REPO}/actions/runners/{runner["id"]}','DELETE')
                except urllib.error.HTTPError as e:
                    if e.code != 404:raise
        except Exception:
            deregistration_failed = True
        finally:
            # GitHub outages/authentication errors must never block Azure teardown.
            # Explicit teardown is limited by this isolated Terraform state.
            (directory/'destroy.log').write_text(run(tf+['destroy','-input=false','-auto-approve','-var-file='+str(directory/'approved.tfvars.json')],env=env))
        if deregistration_failed:
            print('Azure teardown completed; GitHub deregistration still needs verification.')
        print('Removed private VM, disk, NIC, NAT, public egress IP and lease grants.')


if __name__ == '__main__':
    try:
        with runner_lock() as check_lease:
            LEASE_CHECK = check_lease
            operate(check_lease)
    except Exception as error:
        # Never emit an HTTP body, command output or private input.
        print(f'Runner operation stopped: {type(error).__name__}; inspect private evidence and run destroy.')
        raise SystemExit(1)
