"""Shared renewable Blob lease serializes operator and scheduled subnet changes."""
from contextlib import contextmanager
import subprocess
import threading
import time
import uuid

SUBSCRIPTION = 'e854f594-274f-4051-841b-78df7655d73c'

@contextmanager
def runner_lock():
    lease = str(uuid.uuid4())
    stop = threading.Event()
    failed = threading.Event()
    def command(operation):
        args = ['az','storage','blob','lease',operation,'--subscription',SUBSCRIPTION,'--auth-mode','login','--account-name','stwarthogtfauee854','--container-name','runner-locks','--blob-name','runner-subnet.lock','--only-show-errors','-o','none']
        args += ['--lease-duration','60','--proposed-lease-id',lease] if operation=='acquire' else ['--lease-id',lease]
        return subprocess.run(args,capture_output=True,text=True,timeout=35)
    deadline=time.monotonic()+120
    while True:
        result=command('acquire')
        if result.returncode==0:break
        if not ('LeaseAlreadyPresent' in result.stderr or 'LeaseIsBreaking' in result.stderr):
            raise RuntimeError('Runner coordination lease unavailable; no network mutation permitted')
        if time.monotonic()>deadline:raise RuntimeError('Another runner operation holds the network lease')
        time.sleep(5)
    def renew():
        while not stop.wait(15):
            try:
                if command('renew').returncode:failed.set();return
            except Exception:failed.set();return
    thread=threading.Thread(target=renew,daemon=True);thread.start()
    def check():
        if failed.is_set():raise RuntimeError('Runner coordination lease lost; stop network mutations')
    try:yield check
    finally:
        stop.set();thread.join(timeout=40)
        try:command('release')
        except Exception:pass
