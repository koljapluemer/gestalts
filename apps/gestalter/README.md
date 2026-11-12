# gestalter

A personal learning and note-taking app: views as tabs (`distribution/`), with the note views always there and others
installable. The desktop app (`../node/desktop`) keeps your ymls in a folder on this computer, serves gestalter on
`127.0.0.1:7717` and runs plugin backends. The Android app (`../node/android`, page in `distribution-android/`) keeps
the ymls on the phone and syncs them with the paired desktop. See [`doc/desktop.md`](doc/desktop.md),
[`doc/android.md`](doc/android.md) and [`doc/next-steps.md`](doc/next-steps.md).

From the repo root: `mise run gestalter:dev` (desktop app and gestalter, hot reload), `mise run android:dev`.
On Linux, building the desktop app needs no GTK; its tray talks D-Bus directly.

## Shipping

`mise run node:package` builds gestalter (`mise run gestalter:build`, into `distribution/dist`), embeds it in the
desktop app and builds this OS's installers into `target/packages` (Linux: `.deb`, `.rpm`, AppImage; macOS: `.dmg`;
Windows: setup `.exe`). `mise run node:install` builds them and installs one here like a user would. `mise run
android:build` builds a debug APK ([`doc/android.md`](doc/android.md)).
