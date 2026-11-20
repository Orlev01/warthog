"""Initial vault installation on the private bootstrap client, never a runner job.

Inputs are Azure Run Command protected environment parameters. No values are
printed. Existing unequal secrets are rejected, not rotated. No provider call,
message, DNS update, database connection or app deployment occurs here.
"""
import base64
import json
import os
import re
import secrets
import urllib.error
import urllib.request

VAULT = 'https://kv-warthog-aue-e854.vault.azure.net'
NAMES = {
    'POSTGRES_ADMIN_PASSWORD': 'postgres-admin-password',
    'POSTGRES_MIGRATE_PASSWORD': 'postgres-migrate-password',
    'POSTGRES_RUNTIME_PASSWORD': 'postgres-runtime-password',
    'POSTGRES_PURGER_PASSWORD': 'postgres-purger-password',
    'POSTGRES_DELIVERY_PASSWORD': 'postgres-delivery-password',
    'WARTHOG_HMAC_KEY': 'warthog-hmac-key',
    'VAPID_PRIVATE_KEY': 'vapid-private-key',
    'VAPID_PUBLIC_KEY': 'vapid-public-key',
    'MICROSOFT_CLIENT_ID': 'microsoft-client-id',
    'MICROSOFT_CLIENT_SECRET': 'microsoft-client-secret',
    'RESEND_API_KEY': 'resend-api-key',
    'TWILIO_ACCOUNT_SID': 'twilio-account-sid',
    'TWILIO_API_KEY_SID': 'twilio-api-key-sid',
    'TWILIO_API_KEY_SECRET': 'twilio-api-key-secret',
    'GOOGLE_CLIENT_ID': 'google-client-id',
    'GOOGLE_CLIENT_SECRET': 'google-client-secret',
    'GOOGLE_EARLY_ACCESS': 'google-early-access',
    # Optional, installed on its own when the founder registers the LinkedIn app (docs/linkedin-launch.md).
    'LINKEDIN_CLIENT_SECRET': 'linkedin-client-secret',
    'DATABASE_URL': 'database-url',
    'MIGRATION_DATABASE_URL': 'migration-database-url',
    'PURGE_DATABASE_URL': 'purge-database-url',
    'OWNERSHIP_DATABASE_URL': 'ownership-database-url',
}


def main():
    token = os.environ.pop('WARTHOG_VAULT_TOKEN')
    # Setup on 10 Nov tagged its secrets with that day; a later optional install says so instead.
    origin = os.environ.pop('WARTHOG_SECRET_ORIGIN', 'authorized-setup-2026-11-10')
    if not re.fullmatch(r'[a-z0-9-]{3,64}', origin):
        raise RuntimeError('Unexpected origin tag')
    values = json.loads(os.environ.pop('WARTHOG_SECRET_BUNDLE'))
    if not values or not set(values).issubset(NAMES) or any(not isinstance(v,str) or not v for v in values.values()):
        raise RuntimeError('Unexpected or empty secret input')
    def api(path, method='GET', body=None, allow_missing=False):
        request = urllib.request.Request(VAULT+path+'?api-version=7.4', method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+token, 'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if allow_missing and error.code==404:
                return None
            raise RuntimeError('Vault operation failed with HTTP '+str(error.code)) from None
    ids = {}
    for name, value in values.items():
        secret_name = NAMES[name]
        path = '/secrets/'+secret_name
        old = api(path, allow_missing=True)
        if old is not None:
            if not secrets.compare_digest(old['value'], values[name]):
                raise RuntimeError('Existing secret differs; refusing implicit rotation')
            result = old
        else:
            result = api(path, 'PUT', {'value':values[name], 'attributes':{'enabled':True}, 'tags':{'application':'warthog', 'stage':'prepared', 'origin':origin}})
        # Independent value readback, but emit only the immutable version URL.
        verified = api('/secrets/'+secret_name+'/'+result['id'].rsplit('/',1)[1])
        if not secrets.compare_digest(verified['value'],values[name]):
            raise RuntimeError('Secret readback mismatch')
        ids[name] = result['id']
    key = api('/keys/warthog-wrap', allow_missing=True)
    if key is None:
        key = api('/keys/warthog-wrap/create','POST',{'kty':'RSA-HSM','key_size':3072,'key_ops':['wrapKey','unwrapKey'],'attributes':{'enabled':True},'tags':{'application':'warthog'}})
    if key['key']['kty'] != 'RSA-HSM' or set(key['key']['key_ops']) != {'wrapKey','unwrapKey'}:
        raise RuntimeError('Unexpected wrapping key properties')
    challenge = secrets.token_bytes(32)
    encode = lambda value:base64.urlsafe_b64encode(value).rstrip(b'=').decode()
    key_path = key['key']['kid'].removeprefix(VAULT)
    wrapped = api(key_path+'/wrapkey','POST',{'alg':'RSA-OAEP-256','value':encode(challenge)})
    unwrapped = api(key_path+'/unwrapkey','POST',{'alg':'RSA-OAEP-256','value':wrapped['value']})
    if not secrets.compare_digest(base64.urlsafe_b64decode(unwrapped['value']+'='*(-len(unwrapped['value'])%4)),challenge):
        raise RuntimeError('HSM wrap/unwrap failed')
    print(json.dumps({'secret_urls':ids,'wrapping_key_id':key['key']['kid'],'rsa_hsm_roundtrip':True,'database_logins_created':False,'provider_acceptance':False}))


if __name__ == '__main__':
    try:main()
    except Exception as error:
        print('Secret installation stopped: '+type(error).__name__+'; no values displayed.')
        raise SystemExit(1)
