"""Initialize the new private PostgreSQL database and versioned connection URLs.

Run only through a private setup VM that will never be registered as a GitHub runner.
The protected parameter is a short-lived founder Key Vault token. Passwords come
from the vault and reach libpq through environment/TTY, never argv or transcripts.
Application migrations remain part of the separately reviewed application release.
"""
import base64
import ipaddress
import json
import os
from pathlib import Path
import pty
import select
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

VAULT = 'https://kv-warthog-aue-e854.vault.azure.net'
HOST = 'pg-warthog-prod-aue-e854.postgres.database.azure.com'
ROLES = ['warthog_migrate', 'warthog_runtime', 'warthog_purger', 'warthog_delivery']


def main():
    os.umask(0o077)
    token = os.environ.pop('WARTHOG_VAULT_TOKEN')
    bootstrap = base64.b64decode(os.environ.pop('WARTHOG_DB_BOOTSTRAP_SQL_B64'))
    def vault(path, method='GET', body=None):
        req=urllib.request.Request(VAULT+path+'?api-version=7.4', method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
    addresses={item[4][0] for item in socket.getaddrinfo(HOST,5432,type=socket.SOCK_STREAM)}
    if not addresses or any(ipaddress.ip_address(a) not in ipaddress.ip_network('10.64.2.0/27') for a in addresses):
        raise RuntimeError('Database does not resolve into its reviewed private subnet')
    passwords={role:vault('/secrets/postgres-'+role.removeprefix('warthog_')+'-password')['value'] for role in ROLES}
    admin=vault('/secrets/postgres-admin-password')['value']
    env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in ('WARTHOG_VAULT_TOKEN','WARTHOG_DB_BOOTSTRAP_SQL_B64')}
    env.update(PGHOST=HOST,PGPORT='5432',PGDATABASE='postgres',PGUSER='warthog_bootstrap',PGPASSWORD=admin,
               PGSSLMODE='verify-full',PGSSLROOTCERT='/etc/ssl/certs/ca-certificates.crt',PGCONNECT_TIMEOUT='15',LC_ALL='C',
               PGOPTIONS='-c password_encryption=scram-sha-256')
    def sql(statement, *, environment=None):
        result=subprocess.run(['psql','-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],input=statement,env=environment or env,text=True,capture_output=True,timeout=90)
        if result.returncode:raise RuntimeError('Private database bootstrap command failed; output withheld')
        return result.stdout.strip()
    if sql('SELECT current_user')!='warthog_bootstrap':raise RuntimeError('Unexpected database administrator')
    sql(bootstrap.decode())
    env['PGDATABASE']='warthog'
    sql("""DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='warthog_delivery') THEN
        CREATE ROLE warthog_delivery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT FROM pg_roles WHERE rolname='warthog_delivery' AND
          (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin))
         OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='warthog_delivery')
      THEN RAISE EXCEPTION 'Unexpected delivery role privileges'; END IF;
    END $$;
    GRANT CONNECT ON DATABASE warthog TO warthog_delivery;
    ALTER ROLE warthog_delivery SET default_transaction_read_only=on;
    ALTER ROLE warthog_delivery SET statement_timeout='15s';
    ALTER ROLE warthog_delivery SET idle_in_transaction_session_timeout='30s';
    """)
    # psql's password command generates the SCRAM verifier client-side and disables
    # terminal echo while collecting each password. Never retain the TTY transcript.
    master,slave=pty.openpty()
    process=subprocess.Popen(['psql','-X','-q','--no-password','-v','ON_ERROR_STOP=1','-v','PROMPT1=WARTHOG_READY> '],env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave)
    pending=b''
    def expect(marker):
        nonlocal pending
        deadline=time.monotonic()+30
        while marker not in pending:
            if time.monotonic()>deadline or process.poll() is not None:raise RuntimeError('Password initialization did not complete')
            if select.select([master],[],[],1)[0]:pending+=os.read(master,65536)
        pending=pending.split(marker,1)[1]
    try:
        expect(b'WARTHOG_READY> ')
        for role in ROLES:
            os.write(master,('\\password '+role+'\n').encode())
            expect(('Enter new password for user "'+role+'": ').encode())
            os.write(master,(passwords[role]+'\n').encode())
            expect(b'Enter it again: ')
            os.write(master,(passwords[role]+'\n').encode())
            expect(b'WARTHOG_READY> ')
        os.write(master,b'\\q\n');process.wait(timeout=10)
        if process.returncode:raise RuntimeError('Password initialization failed')
    finally:
        os.close(master)
        if process.poll() is None:process.terminate();process.wait(timeout=10)
    evidence={}
    url_names={'warthog_migrate':'migration-database-url','warthog_runtime':'database-url','warthog_purger':'purge-database-url','warthog_delivery':'ownership-database-url'}
    for role in ROLES:
        login=dict(env,PGUSER=role,PGPASSWORD=passwords[role])
        if sql('SELECT current_user',environment=login)!=role:raise RuntimeError('Distinct login verification failed')
        if sql("SELECT ssl AND version IN ('TLSv1.2','TLSv1.3') FROM pg_stat_ssl WHERE pid=pg_backend_pid()",environment=login)!='t':raise RuntimeError('TLS verification failed')
        if role=='warthog_delivery':
            if sql('SHOW default_transaction_read_only',environment=login)!='on':raise RuntimeError('Delivery connection must be read-only')
            if sql('SELECT pg_try_advisory_lock(1463898708, 1)',environment=login)!='t':raise RuntimeError('Delivery advisory-lock probe failed')
            # psql exits after the probe, releasing its session lock.
        value='postgresql://'+role+':'+urllib.parse.quote(passwords[role],safe='')+'@'+HOST+':5432/warthog?sslmode=verify-full'
        name=url_names[role]
        result=vault('/secrets/'+name,'PUT',{'value':value,'attributes':{'enabled':True},'tags':{'application':'warthog','stage':'private-database-verified'}})
        if vault('/secrets/'+name+'/'+result['id'].rsplit('/',1)[1])['value']!=value:raise RuntimeError('Connection secret verification failed')
        evidence[name]=result['id']
    print(json.dumps({'postgres_private_dns':True,'tls_verify_full':True,'distinct_logins':ROLES,'delivery_read_only':True,'secret_urls':evidence,'application_migrations_run':False}))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Database setup stopped: '+type(error).__name__+'; no passwords or SQL transcript displayed.')
        raise SystemExit(1)
