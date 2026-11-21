#!/usr/bin/env bash
# Nightly (cron, as root): the database as a consistent copy, and the data folder, to EU object storage with restic.
# Needs RESTIC_REPOSITORY, RESTIC_PASSWORD and the storage's credentials in /etc/gestalts-teacher-backup.env.
set -euo pipefail
set -a; . /etc/gestalts-teacher-backup.env; set +a
data=/var/lib/gestalts-teacher
sqlite3 "$data/teacher.db" ".backup '$data/teacher.db.backup'"
restic backup --exclude "$data/teacher.db" --exclude "$data/teacher.db-wal" --exclude "$data/teacher.db-shm" --exclude "$data/npm-cache" "$data"
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
