# Railway Bucket backups

The service stores encrypted, deduplicated Restic snapshots in the separate
`t3-code-backups` bucket. No OverlayFS mount is required. The bucket survives
service deletion; deleting the entire Railway project or bucket is outside
this workflow and can destroy the backups.

## Schedule and sleep

- While running: backup at startup when overdue, then every 6 hours.
- While sleeping: no timer runs and no external scheduler wakes the service.
- Graceful shutdown: attempt one final backup within the configured 150-second
  draining window. This is best effort, including platform sleep/teardown;
  SIGKILL, OOM, host failure, or a slow upload can interrupt it.
- Automatic sleep stays enabled. Backup network traffic resets Railway's idle
  clock. Long-running connections or agent traffic can also prevent sleep.
- A failed scheduled backup is retried after 6 hours; no snapshot is claimed as
  successful unless Restic backup and metadata checks both succeed.

## What is saved

`/home/node` includes workspaces, `.git`, uncommitted files, `.t3`, `.codex`,
user tools, configuration and credentials. Restic encrypts file contents and
metadata. Its credentials are removed from the T3/agent child environment.
Top-level `.cache`, `.npm`, backup bookkeeping and runtime sockets/pipes are
excluded. System packages outside `/home/node` must be rebuilt from Dockerfile.

SQLite files are detected by their header and copied with SQLite's online backup
API, including committed WAL changes, then checked. Scheduled copies of other
files are not a globally atomic filesystem snapshot; files may change while
copied. The pre-delete workflow stops T3 and its user processes first.
Running commands, RAM and terminal processes are not restored.

All snapshots are retained. No automatic prune/delete policy is enabled.
Backups incur bucket storage and transfer usage. Current home volume capacity is
500 MB. Staging and restore verification also require temporary container disk
space; insufficient space fails the operation and blocks managed deletion.

## Recovery material

A protected, Git-ignored file at the repository root,
`.env.backup-recovery.json`, contains the bucket endpoint and credentials,
Restic encryption password, and Railway IDs. Keep a separate secure copy outside
this machine and Railway service. Without that password, encrypted snapshots
cannot be recovered. Never commit this file or paste it into chat/logs.

The CLI manager expects Railway login plus the registered SSH key. Defaults in
`manage-backups.py` match this workspace; adjust `CLI`, `KEY` and `RECOVERY` on a
new administration machine. No Railway token is stored in the recovery file.

## Commands

Run from the repository root:

```sh
python3 deploy/railway/manage-backups.py backup
python3 deploy/railway/manage-backups.py snapshots
python3 deploy/railway/manage-backups.py check
```

`check` downloads and verifies all repository data. To test the full final-backup
path without deleting the running service:

```sh
python3 deploy/railway/manage-backups.py prepare-delete
python3 deploy/railway/manage-backups.py resume
```

`prepare-delete` stops T3 and all user processes, uploads a fresh snapshot, and
restores it to a temporary directory with content and SQLite verification. It
leaves T3 paused. On any failure, deletion is blocked; use `resume` to return to
work after investigating. Do this only after finishing active agent work.

To actually delete the service, always use:

```sh
python3 deploy/railway/manage-backups.py delete
```

This repeats the final backup and restore verification, saves the snapshot ID in
`.env.last-backup-receipt.json`, and only then deletes the service. It never calls
the bucket or project deletion API. Direct dashboard/API deletion bypasses this
gate and cannot be protected by the container's shutdown hook.

## Restore

Choose an exact snapshot ID from `snapshots` or the saved receipt. Restore into
a NEW service with a NEW empty volume (never overwrite live state):

```sh
python3 deploy/railway/manage-backups.py restore-new \
  --snapshot SNAPSHOT_ID --name t3-code-restored
```

The manager creates the service and volume, injects credentials over stdin,
sets `T3_RESTORE_SNAPSHOT`, and uploads the image. First startup restores and
verifies data before starting T3. A `.restore-complete` marker prevents future
starts from restoring again. Existing nonempty targets are rejected. If restore
is interrupted, preserve the failed target for inspection and retry with a new
empty volume. The command starts deployment; inspect deployment status, then
create its HTTPS domain and generate a new pairing token:

```sh
railway deployment list --json
railway domain --port 3773
railway ssh -- gosu node t3 pair --base-dir /home/node/.t3
```

Restore uses the versions pinned in Dockerfile. Keep the corresponding image or
Git revision with snapshots when upgrading T3; restoring a newer database into
an older T3 version is unsupported. New restore services use the same repository
and host label, so snapshots should always be selected by exact ID.
