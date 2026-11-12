"""Hermetic supervisor tests: no network, Azure login or GitHub dispatch."""
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.parse

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('hosted_cleanup',ROOT/'cleanup_recovery_drill.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
START=h.stamp('2026-11-12T10:00:00Z')
def config():return h.Config('a'*64,h.iso(START),h.iso(START+dt.timedelta(hours=3)),h.iso(START+dt.timedelta(hours=4)))
def group():return {'id':h.RG_ID,'location':'australiaeast','tags':config().tags.copy()}
def environment():
    return {'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'Orlev01/warthog','GITHUB_REPOSITORY_ID':'1451921931','GITHUB_REPOSITORY_OWNER_ID':'180486014','GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_WORKFLOW_REF':h.WORKFLOW,'GITHUB_ACTOR':'Orlev01','GITHUB_SHA':'b'*40,'DRILL_APPROVED_WORKFLOW_SHA':'b'*40,'DRILL_EXECUTION_APPROVED':'true','DRILL_SUPERVISOR_SHA256':hashlib.sha256((ROOT/'cleanup_recovery_drill.py').read_bytes()).hexdigest(),'DRILL_MANIFEST_SHA256':'a'*64,'DRILL_STARTED_AT':h.iso(START),'DRILL_CLEANUP_AT':h.iso(START+dt.timedelta(hours=3)),'DRILL_DEADLINE_AT':h.iso(START+dt.timedelta(hours=4)),'ACTIONS_ID_TOKEN_REQUEST_URL':'https://pipelines.actions.githubusercontent.com/fixed/oidctoken?api-version=2.0','ACTIONS_ID_TOKEN_REQUEST_TOKEN':'synthetic-github-request-token'}
def jwt(clock,overrides=None):
    claims={'tid':h.TENANT,'oid':h.PRINCIPAL,'appid':h.CLIENT,'aud':'https://management.azure.com/','exp':(clock()+dt.timedelta(hours=1)).timestamp(),**(overrides or {})}
    encoded=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=');return 'synthetic.'+encoded+'.not-a-signature'
class Clock:
    def __init__(self,at=START):self.at=at
    def __call__(self):return self.at
    def sleep(self,seconds):self.at+=dt.timedelta(seconds=seconds)
class FakeAzure:
    def __init__(self,clock,value=None):self.clock=clock;self.value=group() if value is None else value;self.logins=[];self.calls=[];self.deleted=False;self.remaining_gets=1
    def fresh_login(self):self.logins.append(self.clock())
    def call(self,method):
        self.calls.append((method,self.clock()))
        if method=='DELETE':self.deleted=True;return {}
        if self.deleted:
            if self.remaining_gets==0:return None
            self.remaining_gets-=1
        return copy.deepcopy(self.value)

class Tests(unittest.TestCase):
    def setUp(self):
        self.network=patch.object(h.urllib.request.OpenerDirector,'open',side_effect=AssertionError('Network forbidden in offline tests'));self.network.start()
    def tearDown(self):self.network.stop()
    def test_exact_context_and_script_hash_required(self):
        h.configuration(environment())
        for key,value in [('GITHUB_REPOSITORY','other/warthog'),('GITHUB_REF','refs/heads/topic'),('GITHUB_EVENT_NAME','pull_request'),('GITHUB_REPOSITORY_ID','1'),('GITHUB_REPOSITORY_OWNER_ID','2'),('GITHUB_WORKFLOW_REF','other'),('GITHUB_ACTOR','other'),('DRILL_EXECUTION_APPROVED','false'),('DRILL_APPROVED_WORKFLOW_SHA','c'*40),('DRILL_SUPERVISOR_SHA256','d'*64)]:
            with self.subTest(key=key),self.assertRaises(h.Blocked):h.configuration({**environment(),key:value})
    def test_exact_three_four_hour_window_and_canonical_utc(self):
        for cleanup,deadline in [(2,4),(3,5),(4,3)]:
            with self.assertRaises(h.Blocked):h.Config('a'*64,h.iso(START),h.iso(START+dt.timedelta(hours=cleanup)),h.iso(START+dt.timedelta(hours=deadline)))
        for value in ['2026-11-12T10:00:00','2026-11-12T10:00:00+00:00','not-time']:
            with self.assertRaises(h.Blocked):h.stamp(value)
        with self.assertRaises(h.Blocked):config().check_time(START+dt.timedelta(minutes=31),arming=True)
        with self.assertRaises(h.Blocked):config().check_time(START-dt.timedelta(seconds=1))
    def test_scope_manifest_time_and_owner_drift_rejected(self):
        config().check_group(group())
        for key,value in [('id',h.RG_ID.replace('pitr-drill','prod')),('location','eastus'),('tags',None)]:
            with self.assertRaises(h.Blocked):config().check_group({**group(),key:value})
        for key in config().tags:
            changed=group();changed['tags'][key]='unexpected'
            with self.subTest(key=key),self.assertRaises(h.Blocked):config().check_group(changed)
    def test_arming_has_no_delete_and_missing_group_fails(self):
        clock=Clock();az=FakeAzure(clock);out=[];s=h.Supervisor(config(),az,clock,clock.sleep,lambda event,**data:out.append((event,data)));s.arm()
        self.assertEqual([m for m,_ in az.calls],['GET']);self.assertEqual(out[0][0],'armed')
        az.call=lambda _:None
        with self.assertRaises(h.Blocked):s.arm()
    def test_supervisor_waits_then_fresh_login_and_actual_absence(self):
        clock=Clock();az=FakeAzure(clock);out=[];s=h.Supervisor(config(),az,clock,clock.sleep,lambda event,**data:out.append((event,data)));s.supervise()
        deletes=[at for method,at in az.calls if method=='DELETE'];self.assertEqual(deletes,[START+dt.timedelta(hours=3)])
        self.assertEqual(az.logins,[START,START+dt.timedelta(hours=3)])
        self.assertEqual(out[-1][0],'resource_group_absent');self.assertTrue(out[-1][1]['within_four_hours']);self.assertFalse(out[-1][1]['independent_child_verification'])
    def test_tag_change_before_deletion_fails_closed(self):
        clock=Clock(START+dt.timedelta(hours=3));az=FakeAzure(clock);az.value['tags']['manifest_sha256']='b'*64
        with self.assertRaises(h.Blocked):h.Supervisor(config(),az,clock,clock.sleep,lambda *a,**k:None).cleanup()
        self.assertNotIn('DELETE',[m for m,_ in az.calls])
    def test_delete202_does_not_claim_absence(self):
        clock=Clock(START+dt.timedelta(hours=3));az=FakeAzure(clock);az.remaining_gets=4;out=[]
        h.Supervisor(config(),az,clock,clock.sleep,lambda event,**data:out.append((event,data))).cleanup()
        self.assertEqual(out[0][0],'delete_requested');self.assertEqual(out[-1][0],'resource_group_absent');self.assertGreater(clock(),START+dt.timedelta(hours=3,minutes=1))
    def test_exact_group_retry_and_overdue_warning(self):
        clock=Clock(START+dt.timedelta(hours=4));az=FakeAzure(clock);original=az.call;attempts=0;out=[]
        def call(method):
            nonlocal attempts
            if method=='DELETE':
                attempts+=1
                if attempts==1:raise h.CloudFailure(409)
            return original(method)
        az.call=call
        h.Supervisor(config(),az,clock,clock.sleep,lambda event,**data:out.append((event,data))).cleanup()
        self.assertTrue(any(e=='overdue_cleanup_continue' for e,_ in out));self.assertFalse(out[-1][1]['within_four_hours']);self.assertEqual(attempts,2)
    def test_interruption_requests_early_exact_cleanup(self):
        clock=Clock();az=FakeAzure(clock);s=h.Supervisor(config(),az,clock,clock.sleep,lambda *a,**k:None);s.signal();s.supervise()
        self.assertEqual([at for method,at in az.calls if method=='DELETE'],[START])
    def test_hosted_job_cannot_write_arbitrary_resources(self):
        clock=Clock();requests=[]
        def transport(request):
            requests.append(request)
            if 'oidctoken' in request.full_url:return 200,{'value':'synthetic-oidc'}
            if 'login.microsoftonline.com' in request.full_url:
                form=urllib.parse.parse_qs(request.data.decode());self.assertEqual(form['client_id'],[h.CLIENT]);self.assertEqual(form['client_assertion'],['synthetic-oidc']);return 200,{'access_token':jwt(clock),'expires_in':3600}
            self.assertEqual(request.full_url,h.ARM_URL);self.assertIn(request.get_method(),['GET','DELETE']);return (200,group()) if request.get_method()=='GET' else (202,{})
        az=h.Azure(environment(),transport,clock);az.call('GET');clock.sleep(3*3600);az.call('DELETE')
        self.assertEqual(sum('oidctoken' in r.full_url for r in requests),2)
        self.assertEqual(sum('login.microsoftonline.com' in r.full_url for r in requests),2)
        with self.assertRaises(h.Blocked):az.call('PUT')
        az.clear();self.assertIsNone(az._token)
    def test_mismatched_token_identity_is_rejected_before_arm_request(self):
        for change in [{'tid':'other'},{'oid':'other'},{'appid':'other'},{'aud':'https://vault.azure.net'}]:
            calls=[];clock=Clock()
            def transport(request):
                calls.append(request.full_url)
                if 'oidctoken' in request.full_url:return 200,{'value':'synthetic'}
                return 200,{'access_token':jwt(clock,change),'expires_in':3600}
            with self.subTest(change=change),self.assertRaises(h.Blocked):h.Azure(environment(),transport,clock).call('GET')
            self.assertFalse(any('management.azure.com/subscriptions' in url for url in calls))
    def test_untrusted_oidc_endpoint_or_audience_rejected_without_request(self):
        for endpoint in ['https://example.test/oidc','http://pipelines.actions.githubusercontent.com/oidc','https://pipelines.actions.githubusercontent.com/oidc?audience=other']:
            def transport(_):raise AssertionError('Must reject before request')
            with self.assertRaises(h.Blocked):h.Azure({**environment(),'ACTIONS_ID_TOKEN_REQUEST_URL':endpoint},transport,Clock()).fresh_login()
    def test_auth_retry_uses_fresh_oidc_not_old_cached_assertion(self):
        clock=Clock();calls=[];arm_attempts=0
        def transport(request):
            nonlocal arm_attempts
            calls.append(request.full_url)
            if 'oidctoken' in request.full_url:return 200,{'value':'synthetic'}
            if 'login.microsoftonline.com' in request.full_url:return 200,{'access_token':jwt(clock),'expires_in':3600}
            arm_attempts+=1
            if arm_attempts==1:raise h.CloudFailure(401)
            return 200,group()
        self.assertEqual(h.Azure(environment(),transport,clock).call('GET')['id'],h.RG_ID)
        self.assertEqual(sum('oidctoken' in x for x in calls),2)
    def test_logs_never_include_tokens_or_billing_data(self):
        clock=Clock();az=FakeAzure(clock);out=[];h.Supervisor(config(),az,clock,clock.sleep,lambda event,**data:out.append((event,data))).supervise()
        text=json.dumps(out);self.assertNotIn('Bearer',text);self.assertNotIn('client_assertion',text);self.assertNotIn('access_token',text);self.assertNotIn('balance',text)

if __name__=='__main__':unittest.main()
