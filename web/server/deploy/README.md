# Deploying the teacher app

One EU box (Hetzner or the like) runs `gestalts-teacher` behind Caddy, for two domains: the app (teachers, `/api`)
and the lesson domain (students). `scripts/deploy-teacher.sh` ships a release; this is the box's one-time setup.

On the box (Debian/Ubuntu), as root:

1. Caddy, Node 26 with pnpm (`corepack enable`), `sqlite3` and `restic`.
2. A user and folders: `useradd --system --home /var/lib/gestalts-teacher teacher`, `mkdir -p /opt/gestalts-teacher/releases /var/lib/gestalts-teacher`, `chown -R teacher: /opt/gestalts-teacher /var/lib/gestalts-teacher`.
3. `/etc/gestalts-teacher.env` (mode 600): `ANTHROPIC_API_KEY=…` and `TEACHER_LESSON_ORIGIN=https://<lesson domain>`.
4. `Caddyfile` here to `/etc/caddy/Caddyfile`, with the two domains, and both domains' DNS at the box.
5. `gestalts-teacher.service` to `/etc/systemd/system/`, then `systemctl enable gestalts-teacher`.
6. Backups: `backup.sh` to `/usr/local/bin/`, `/etc/gestalts-teacher-backup.env` with the restic repository, and a
   nightly cron entry for it.

Then, from a committed tree here: `TEACHER_HOST=root@box mise run teacher:deploy`. Schools and teachers on the box:
`sudo -u teacher /opt/gestalts-teacher/current/bin/gestalts-teacher --data /var/lib/gestalts-teacher admin add-school "…"`,
then `admin add-teacher --school <id> --email <email>`, which prints the password to hand over.

Every player a deploy installs stays (`/var/lib/gestalts-teacher/runtime/`), so lessons published against an older
runtime keep opening. Before teachers use it: a processing agreement with Anthropic (what teachers type goes to the
model), and a line in the terms saying so.
