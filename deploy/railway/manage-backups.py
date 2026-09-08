#!/usr/bin/env python3
"""Run from this directory. Recovery secrets stay outside Git."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
RECOVERY = ROOT.parents[1] / '.env.backup-recovery.json'
CLI = shutil.which('railway') or '/home/boxuser/.local/share/t3-railway-cli/node_modules/.bin/railway'
KEY = Path('/home/boxuser/.ssh/t3_railway')


def cli(*args, **kwargs):
    return subprocess.run([CLI, *args], cwd=ROOT, check=True, text=True, **kwargs)


def remote(config, service, *args):
    command = shlex.join(['backupctl', *args])
    return cli('ssh', '-p', config['project_id'], '-e', config['environment_id'], '-s', service,
               '-i', str(KEY), '--', command, capture_output=True).stdout


def variables(config):
    c = config['bucket_credentials']
    return {
        'RESTIC_REPOSITORY': 's3:' + c['endpoint'].rstrip('/') + '/' + c['bucketName'] + '/t3-home',
        'RESTIC_PASSWORD': config['restic_password'],
        'AWS_ACCESS_KEY_ID': c['accessKeyId'],
        'AWS_SECRET_ACCESS_KEY': c['secretAccessKey'],
        'AWS_DEFAULT_REGION': c['region'],
        'T3_BACKUP_S3_LOOKUP': 'dns' if c['urlStyle'] == 'virtual-host' else 'path',
        'T3_BACKUP_INTERVAL_SECONDS': '21600',
        'PORT': '3773',
    }


def configure(config, service, snapshot=None):
    data = variables(config)
    if snapshot:
        data['T3_RESTORE_SNAPSHOT'] = snapshot
    # Values go over stdin, never argv or logs.
    for name, value in data.items():
        cli('variable', 'set', name, '--stdin', '--skip-deploys', '--project', config['project_id'],
            '--environment', config['environment_id'], '--service', service,
            input=value, capture_output=True)
    query = 'mutation($s:String!,$e:String!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:{sleepApplication:true,numReplicas:1,healthcheckPath:"/",healthcheckTimeout:300,drainingSeconds:150,restartPolicyType:ON_FAILURE,restartPolicyMaxRetries:10})}'
    cli('api', query, '--variables', json.dumps({'s': service, 'e': config['environment_id']}), capture_output=True)


def confirmed_final(config, service):
    output = remote(config, service, 'final')
    report = json.loads(output.strip().splitlines()[-1])
    if not report.get('snapshot_id') or report.get('verified_restore') is not True:
        raise RuntimeError('No verified final snapshot; refusing deletion')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['configure', 'backup', 'snapshots', 'check', 'prepare-delete', 'delete', 'resume', 'restore-new'])
    parser.add_argument('--service', help='Exact service ID; defaults to the original T3 service')
    parser.add_argument('--snapshot', help='Exact snapshot ID for restore-new')
    parser.add_argument('--name', help='New service name for restore-new')
    args = parser.parse_args()
    config = json.loads(RECOVERY.read_text())
    service = args.service or config['service_id']
    if args.action == 'configure':
        configure(config, service)
        print('Backup variables and lifecycle settings configured; deploy to apply.')
    elif args.action == 'restore-new':
        if not args.snapshot or not args.name:
            parser.error('restore-new requires --snapshot and --name')
        cli('link', '--project', config['project_id'], '--environment', config['environment_id'])
        created = json.loads(cli('add', '--service', args.name, '--json', capture_output=True).stdout)
        service = created['id']
        print('New service:', service, flush=True)
        cli('service', 'link', service)
        cli('volume', 'add', '--mount-path', '/home/node', '--json')
        configure(config, service, args.snapshot)
        cli('up', '.', '--path-as-root', '--detach', '--service', service)
        print('Restore deployment started. Check deployment status before generating its domain.')
    elif args.action in ('prepare-delete', 'delete'):
        report = confirmed_final(config, service)
        # Keep receipt locally before any deletion, so the snapshot ID survives.
        receipt = RECOVERY.with_name('.env.last-backup-receipt.json')
        with os.fdopen(os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
            json.dump({**report, 'service_id': service}, f, indent=2)
        print(json.dumps(report), flush=True)
        if args.action == 'delete':
            cli('service', 'delete', '--service', service, '--environment', config['environment_id'], '--yes', '--json')
            print('Service deleted. Backup bucket and project retained.')
        else:
            print('T3 is paused. Run resume to continue; delete performs a fresh final backup.')
    else:
        print(remote(config, service, args.action))

if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f'Operation failed (exit {error.returncode}); no success assumed. If T3 was paused, run resume.', file=sys.stderr)
        sys.exit(1)
