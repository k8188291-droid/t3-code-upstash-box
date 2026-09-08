#!/usr/bin/env python3
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

RUN = Path('/run/t3-backup')
STATE = Path('/home/node/.backup-state.json')
stop = False
paused = False

def handle(sig, _):
    global stop, paused
    if sig in (signal.SIGTERM, signal.SIGINT):
        stop = True
    else:
        paused = sig == signal.SIGUSR1

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGUSR1, signal.SIGUSR2):
    signal.signal(sig, handle)

os.umask(0o077)
RUN.mkdir(mode=0o700, exist_ok=True)
(RUN / 'supervisor.pid').write_text(str(os.getpid()))
interval = int(os.environ.get('T3_BACKUP_INTERVAL_SECONDS', '21600'))
enabled = bool(os.environ.get('RESTIC_REPOSITORY'))
child = None
job = None
retry_after = 0
exit_code = 0

def launch():
    env = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'RESTIC_', 'T3_BACKUP_', 'T3_RESTORE_'))}
    (RUN / 'stopped').unlink(missing_ok=True)
    return subprocess.Popen(['gosu', 'node', 't3', 'serve', '--host', '0.0.0.0', '--port', env.get('PORT', '3773'), '--base-dir', '/home/node/.t3', '/home/node/workspaces'], env=env, start_new_session=True)

def halt():
    global child
    if child is not None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except ProcessLookupError:
            pass
        child = None
    (RUN / 'stopped').touch()

child = launch()
while not stop:
    if paused:
        halt()
    elif child is None:
        child = launch()
    elif child.poll() is not None:
        exit_code = child.returncode or 1
        stop = True
        break
    if job is not None and job.poll() is not None:
        if job.returncode:
            print('Scheduled backup failed; retry on next interval.', flush=True)
        job = None
        retry_after = time.time() + interval
    if enabled and not paused and job is None and time.time() >= retry_after:
        try:
            last = json.loads(STATE.read_text())['time']
        except (FileNotFoundError, ValueError, KeyError):
            last = 0
        if time.time() - last >= interval:
            job = subprocess.Popen(['backupctl', 'backup', '--reason', 'periodic'], start_new_session=True)
    time.sleep(1)

halt()
if job is not None and job.poll() is None:
    try:
        job.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(job.pid, signal.SIGTERM)
        try:
            job.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(job.pid, signal.SIGKILL)
            job.wait()
if enabled:
    # Best effort only: platform SIGKILL/host failure can interrupt this.
    subprocess.run(['pkill', '-TERM', '-u', '1000'], check=False)
    time.sleep(2)
    subprocess.run(['pkill', '-KILL', '-u', '1000'], check=False)
    shutdown_job = subprocess.Popen(['backupctl', 'backup', '--reason', 'shutdown'], start_new_session=True)
    try:
        if shutdown_job.wait(timeout=100):
            print('Shutdown backup failed; previous snapshots remain available.', flush=True)
    except subprocess.TimeoutExpired:
        os.killpg(shutdown_job.pid, signal.SIGTERM)
        try:
            shutdown_job.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(shutdown_job.pid, signal.SIGKILL)
            shutdown_job.wait()
        print('Shutdown backup incomplete; previous snapshots remain available.', flush=True)
sys.exit(exit_code)
