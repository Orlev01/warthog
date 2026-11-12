#!/usr/bin/env python3
"""Dedicated one-drill cleanup supervisor. No resource creation or data APIs.

Execution requires the reviewed manifest, source hash, exact temporary grant and
resource-group tags. Tokens stay in memory; only fixed RG GET/DELETE is allowed.
"""
from __future__ import annotations
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SUB='e854f594-274f-4051-841b-78df7655d73c'
TENANT='72277873-e056-4612-9b1c-7ad58e02fcf3'
CLIENT='f4ef513d-1540-41b1-9cff-562854b0d458'
PRINCIPAL='aba64257-7c15-4f72-a6a3-dd1247e3d0f8'
RG='rg-warthog-pitr-drill-aue-20261112'
RG_ID=f'/subscriptions/{SUB}/resourceGroups/{RG}'
ARM_URL=f'https://management.azure.com{RG_ID}?api-version=2022-09-01'
WORKFLOW='Orlev01/warthog/.github/workflows/azure-recovery-cleanup.yml@refs/heads/main'
MAX_RESPONSE_BYTES=65536
UTC=dt.timezone.utc

class Blocked(RuntimeError):pass
class CloudFailure(RuntimeError):
    def __init__(self,status):self.status=status;super().__init__('cloud_request_failed')
def utcnow():return dt.datetime.now(UTC)
def iso(value):return value.astimezone(UTC).isoformat().replace('+00:00','Z')
def stamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z',value):raise Blocked('invalid_utc_time')
    try:return dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError:raise Blocked('invalid_utc_time') from None
def emit(event,**fields):print(json.dumps({'event':event,**fields},separators=(',',':')),flush=True)

class Config:
    def __init__(self,manifest,started,cleanup,deadline):
        if not re.fullmatch('[a-f0-9]{64}',manifest):raise Blocked('invalid_manifest_hash')
        self.manifest=manifest;self.started=stamp(started);self.cleanup=stamp(cleanup);self.deadline=stamp(deadline)
        if self.cleanup-self.started!=dt.timedelta(hours=3) or self.deadline-self.started!=dt.timedelta(hours=4):raise Blocked('unexpected_time_bounds')
        self.tags={'purpose':'pitr-drill','environment':'isolated','owner':'warthog','manifest_sha256':manifest,'created_at':started,'cleanup_at':cleanup,'expires_at':deadline}
    def check_time(self,current,arming=False):
        if current<self.started or current>self.deadline+dt.timedelta(hours=1):raise Blocked('outside_supervisor_window')
        if arming and current>self.started+dt.timedelta(minutes=30):raise Blocked('arming_too_late_do_not_create_billable_resources')
    def check_group(self,value):
        if not isinstance(value,dict) or not isinstance(value.get('id'),str) or value['id'].lower()!=RG_ID.lower() or not isinstance(value.get('location'),str) or value['location'].replace(' ','').lower()!='australiaeast':raise Blocked('unexpected_resource_group')
        tags=value.get('tags')
        if not isinstance(tags,dict) or any(tags.get(key)!=expected for key,expected in self.tags.items()):raise Blocked('scope_manifest_or_deadline_tags_changed')

def configuration(env,script_path=None):
    required={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'Orlev01/warthog','GITHUB_REPOSITORY_ID':'1451921931','GITHUB_REPOSITORY_OWNER_ID':'180486014','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_WORKFLOW_REF':WORKFLOW,'DRILL_EXECUTION_APPROVED':'true'}
    if any(env.get(key)!=value for key,value in required.items()):raise Blocked('unapproved_workflow_context')
    if env.get('GITHUB_ACTOR','').lower()!='orlev01':raise Blocked('unexpected_dispatch_actor')
    revision=env.get('GITHUB_SHA','')
    if not re.fullmatch('[a-f0-9]{40}',revision) or env.get('DRILL_APPROVED_WORKFLOW_SHA')!=revision:raise Blocked('unreviewed_workflow_revision')
    expected=env.get('DRILL_SUPERVISOR_SHA256','')
    if not re.fullmatch('[a-f0-9]{64}',expected) or hashlib.sha256(Path(script_path or __file__).read_bytes()).hexdigest()!=expected:raise Blocked('unreviewed_supervisor_bytes')
    return Config(env.get('DRILL_MANIFEST_SHA256',''),env.get('DRILL_STARTED_AT',''),env.get('DRILL_CLEANUP_AT',''),env.get('DRILL_DEADLINE_AT',''))

def request_json(request):
    # Never print request headers/body, response error bodies or raw exceptions.
    # Disallow redirects: bearer credentials must remain at their exact endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*_args,**_kwargs):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    try:
        with opener.open(request,timeout=15) as response:
            data=response.read(MAX_RESPONSE_BYTES+1)
            if len(data)>MAX_RESPONSE_BYTES:raise Blocked('oversized_cloud_response')
            return response.status,json.loads(data) if data else {}
    except urllib.error.HTTPError as error:raise CloudFailure(error.code) from None
    except (urllib.error.URLError,TimeoutError):raise CloudFailure(0) from None
    except (json.JSONDecodeError,UnicodeError):raise Blocked('invalid_cloud_json') from None

class Azure:
    def __init__(self,env,transport=request_json,clock=utcnow):
        self.env=env;self.transport=transport;self.clock=clock;self._token=None;self._refresh_at=None
    def fresh_login(self):
        endpoint=self.env.get('ACTIONS_ID_TOKEN_REQUEST_URL','');secret=self.env.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN','')
        parsed=urllib.parse.urlsplit(endpoint)
        if parsed.scheme!='https' or not parsed.hostname or not parsed.hostname.endswith('.actions.githubusercontent.com') or parsed.username or parsed.password or parsed.port not in (None,443) or parsed.fragment or not secret:raise Blocked('invalid_github_oidc_endpoint')
        query=urllib.parse.parse_qsl(parsed.query,keep_blank_values=True)
        if any(k=='audience' for k,_ in query):raise Blocked('unexpected_preexisting_oidc_audience')
        endpoint=urllib.parse.urlunsplit((parsed.scheme,parsed.netloc,parsed.path,urllib.parse.urlencode(query+[('audience','api://AzureADTokenExchange')]),''))
        status,oidc=self.transport(urllib.request.Request(endpoint,headers={'Authorization':'Bearer '+secret,'Accept':'application/json'}))
        assertion=oidc.get('value')
        if status!=200 or not isinstance(assertion,str) or not assertion:raise Blocked('oidc_assertion_unavailable')
        fields={'client_id':CLIENT,'grant_type':'client_credentials','scope':'https://management.azure.com/.default','client_assertion_type':'urn:ietf:params:oauth:client-assertion-type:jwt-bearer','client_assertion':assertion}
        status,value=self.transport(urllib.request.Request(f'https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token',data=urllib.parse.urlencode(fields).encode(),headers={'Content-Type':'application/x-www-form-urlencoded'},method='POST'))
        assertion=None
        token=value.get('access_token')
        if status!=200 or not isinstance(token,str) or not token:raise Blocked('arm_token_unavailable')
        # Endpoint TLS authenticates this token response; ARM validates the token.
        # Claim inspection is only an additional exact-identity guard, not JWT auth.
        try:
            part=token.split('.')[1];claims=json.loads(base64.urlsafe_b64decode(part+'='*(-len(part)%4)))
        except (IndexError,ValueError,UnicodeError):raise Blocked('unexpected_arm_token_shape') from None
        if claims.get('tid')!=TENANT or claims.get('oid')!=PRINCIPAL or claims.get('appid',claims.get('azp'))!=CLIENT or str(claims.get('aud','')).rstrip('/') not in ('https://management.azure.com','https://management.core.windows.net'):raise Blocked('unexpected_arm_identity')
        remaining=min(float(value.get('expires_in',0)),float(claims.get('exp',0))-self.clock().timestamp())
        if remaining<120:raise Blocked('arm_token_too_short')
        self._token=token;self._refresh_at=self.clock()+dt.timedelta(seconds=min(remaining-60,300))
    def call(self,method):
        if method not in ('GET','DELETE'):raise Blocked('unapproved_arm_method')
        if self._token is None or self.clock()>=self._refresh_at:self.fresh_login()
        for attempt in range(2):
            try:
                status,value=self.transport(urllib.request.Request(ARM_URL,headers={'Authorization':'Bearer '+self._token,'Accept':'application/json'},method=method))
                if status not in ((200,) if method=='GET' else (200,202,204)):raise CloudFailure(status)
                return value
            except CloudFailure as error:
                if error.status==404:return None
                if error.status in (401,403) and attempt==0:self.fresh_login();continue
                raise
    def clear(self):self._token=None;self._refresh_at=None

class Supervisor:
    def __init__(self,config,azure,clock=utcnow,sleep=time.sleep,output=emit):
        self.config=config;self.azure=azure;self.clock=clock;self.sleep=sleep;self.output=output;self.interrupted=False
    def signal(self,*_args):self.interrupted=True
    def arm(self):
        self.config.check_time(self.clock(),arming=True);self.azure.fresh_login();group=self.azure.call('GET')
        if group is None:raise Blocked('empty_drill_group_must_exist_before_arming')
        self.config.check_group(group)
        self.output('armed',manifest_sha256=self.config.manifest,target_rg=RG,cleanup_at=iso(self.config.cleanup),deadline_at=iso(self.config.deadline),verified_at=iso(self.clock()),cloud_writes=0)
    def supervise(self):
        self.arm()
        heartbeat=None
        while self.clock()<self.config.cleanup and not self.interrupted:
            self.config.check_time(self.clock());group=self.azure.call('GET')
            if group is None:self.output('group_already_absent',at=iso(self.clock()));return
            self.config.check_group(group)
            if heartbeat is None or self.clock()-heartbeat>=dt.timedelta(seconds=60):
                self.output('supervising',manifest_sha256=self.config.manifest,at=iso(self.clock()));heartbeat=self.clock()
            self.sleep(min(30,max(0,(self.config.cleanup-self.clock()).total_seconds())))
        self.cleanup()
    def cleanup(self):
        # A fresh GitHub assertion/ARM token is acquired AFTER the long wait.
        self.config.check_time(self.clock());self.azure.fresh_login()
        last_delete=None;overdue=False
        while self.clock()<=self.config.deadline+dt.timedelta(hours=1):
            if self.clock()>self.config.deadline and not overdue:
                self.output('overdue_cleanup_continue',at=iso(self.clock()),target_rg=RG);overdue=True
            try:
                group=self.azure.call('GET')
                if group is None:
                    self.output('resource_group_absent',at=iso(self.clock()),within_four_hours=self.clock()<=self.config.deadline,independent_child_verification=False)
                    return
                self.config.check_group(group)
                if last_delete is None or self.clock()-last_delete>=dt.timedelta(minutes=5):
                    self.azure.call('DELETE');last_delete=self.clock()
                    self.output('delete_requested',at=iso(self.clock()),target_rg=RG)
            except CloudFailure as error:
                if error.status not in (0,401,403,409,429,500,502,503,504):raise
                self.output('exact_group_cleanup_retry',status=error.status,at=iso(self.clock()))
            self.sleep(30)
        raise Blocked('deletion_not_verified_manual_exact_scope_cleanup_required')

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['arm','supervise','cleanup-now']);args=parser.parse_args()
    config=configuration(os.environ);azure=Azure(os.environ);supervisor=Supervisor(config,azure)
    signal.signal(signal.SIGTERM,supervisor.signal);signal.signal(signal.SIGINT,supervisor.signal)
    try:
        if args.mode=='arm':supervisor.arm()
        elif args.mode=='supervise':supervisor.supervise()
        else:supervisor.cleanup()
    finally:azure.clear()

if __name__=='__main__':
    try:main()
    except (Blocked,CloudFailure,KeyError,ValueError,OSError) as error:
        emit('blocked',reason=str(error) if isinstance(error,Blocked) else 'cloud_or_input_failure');sys.exit(1)
