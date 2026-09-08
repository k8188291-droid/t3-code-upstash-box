#!/usr/bin/env python3
"""Encrypted home snapshots. Root only; credentials never passed to T3."""
import argparse
from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import stat
import subprocess
import tempfile
import time

HOME_DIR = Path('/home/node')
STAGE = Path('/var/lib/t3-backup/home')
STATE = HOME_DIR / '.backup-state.json'
RUN = Path('/run/t3-backup')
EXCLUDE = {'.cache', '.npm', '.backup-state.json', '.restore-complete'}


def restic(*args):
    result = subprocess.run(['restic', '--no-cache', '-o', 's3.bucket-lookup=' + os.environ.get('T3_BACKUP_S3_LOOKUP', 'dns'), *args], capture_output=True, text=True)
    if result.returncode:
        # Do not expose endpoints or credentials through CLI diagnostics.
        raise RuntimeError(f'restic {args[0]} failed (exit {result.returncode}); backup not confirmed')
    return result.stdout


def sqlite_file(path):
    with path.open('rb') as f:
        return f.read(16) == b'SQLite format 3\0'


def copy_file(source, destination):
    source = Path(source)
    if sqlite_file(source):
        # sqlite backup() includes committed WAL transactions while writers run.
        with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as src:
            with closing(sqlite3.connect(str(destination))) as dst:
                deadline = time.monotonic() + 60
                def progress(*_):
                    if time.monotonic() > deadline:
                        raise TimeoutError('SQLite snapshot did not settle')
                src.backup(dst, pages=256, progress=progress)
                dst.execute("PRAGMA journal_mode=DELETE")
                if dst.execute('PRAGMA quick_check').fetchone() != ('ok',):
                    raise RuntimeError('SQLite integrity check failed')
        shutil.copystat(source, destination)
    else:
        shutil.copy2(source, destination)
    return str(destination)


def ignored(directory, names):
    root = Path(directory)
    skip = set(EXCLUDE & set(names)) if root == HOME_DIR else set()
    for name in names:
        p = root / name
        mode = p.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
            skip.add(name)  # Unix sockets/pipes cannot be restored as live processes.
        if name.endswith(('-wal', '-shm', '-journal')):
            base = root / name.rsplit('-', 1)[0]
            if base.is_file() and not base.is_symlink() and sqlite_file(base):
                skip.add(name)
    return skip


def write_json(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data) + '\n')
    tmp.chmod(0o600)
    tmp.replace(path)


def backup(reason):
    shutil.rmtree(STAGE, ignore_errors=True)
    try:
        shutil.copytree(HOME_DIR, STAGE, symlinks=True, ignore=ignored, copy_function=copy_file)
        output = restic('backup', '--json', '--host', 't3-railway', '--tag', 't3-home-v1', '--tag', reason, str(STAGE))
        summary = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        snapshot = next(item['snapshot_id'] for item in summary if item.get('message_type') == 'summary' and item.get('snapshot_id'))
        restic('check')
        write_json(STATE, {'snapshot_id': snapshot, 'time': time.time(), 'reason': reason})
        return snapshot
    finally:
        shutil.rmtree(STAGE, ignore_errors=True)


def restore(snapshot, target):
    target = Path(target)
    if target.exists() and any(target.iterdir()):
        raise RuntimeError('Restore target must be empty; existing data will not be overwritten')
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='t3-restore-') as temp:
        restic('restore', snapshot, '--target', temp, '--verify')
        source = Path(temp) / str(STAGE).lstrip('/')
        if not source.is_dir():
            raise RuntimeError('Snapshot is not a t3-home-v1 backup')
        for p in source.rglob('*'):
            if p.is_file() and not p.is_symlink() and sqlite_file(p):
                with closing(sqlite3.connect(p.resolve().as_uri() + '?mode=ro', uri=True)) as db:
                    if db.execute('PRAGMA quick_check').fetchone() != ('ok',):
                        raise RuntimeError('Restored SQLite integrity check failed')
        shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)
    for root, dirs, files in os.walk(target, followlinks=False):
        os.chown(root, 1000, 1000)
        for name in dirs + files:
            os.lchown(Path(root) / name, 1000, 1000)


def quiesce():
    pid = int((RUN / 'supervisor.pid').read_text())
    os.kill(pid, signal.SIGUSR1)
    deadline = time.monotonic() + 60
    while not (RUN / 'stopped').exists():
        if time.monotonic() > deadline:
            raise RuntimeError('T3 did not stop; refusing final backup')
        time.sleep(.25)
    # Catch detached agents/terminals too, including children using setsid.
    subprocess.run(['pkill', '-TERM', '-u', '1000'], check=False)
    time.sleep(2)
    subprocess.run(['pkill', '-KILL', '-u', '1000'], check=False)
    r = subprocess.run(['pgrep', '-u', '1000'], capture_output=True)
    if r.returncode == 0:
        raise RuntimeError('User processes remain; refusing final backup')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['init', 'backup', 'final', 'restore', 'snapshots', 'check', 'resume'])
    parser.add_argument('--snapshot')
    parser.add_argument('--target')
    parser.add_argument('--reason', default='manual')
    args = parser.parse_args()
    RUN.mkdir(mode=0o700, exist_ok=True)
    if args.action == 'resume':
        os.kill(int((RUN / 'supervisor.pid').read_text()), signal.SIGUSR2)
        return
    if args.action == 'final':
        quiesce()
    with (RUN / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == 'init':
            try:
                restic('cat', 'config')
            except RuntimeError:
                restic('init')  # init refuses to overwrite an existing repository.
        elif args.action in ('backup', 'final'):
            snapshot = backup('pre-delete' if args.action == 'final' else args.reason)
            if args.action == 'final':
                with tempfile.TemporaryDirectory(prefix='t3-final-check-') as target:
                    restore(snapshot, target)
            print(json.dumps({'snapshot_id': snapshot, 'verified_restore': args.action == 'final'}))
        elif args.action == 'restore':
            if not args.snapshot or not args.target:
                parser.error('restore requires --snapshot and --target')
            restore(args.snapshot, args.target)
            print(json.dumps({'restored': args.snapshot}))
        elif args.action == 'snapshots':
            print(restic('snapshots', '--json', '--tag', 't3-home-v1'))
        else:
            print(restic('check', '--read-data'))

if __name__ == '__main__':
    main()
