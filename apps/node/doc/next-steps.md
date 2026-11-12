# Next steps

The desktop and Android apps' own steps.

- [x] **The desktop app serves the gestalter**, as `gestalter` (formerly `gestalts-connector`).
- [x] **gestalts-node ships no app**: gestalter is a website on it, the node has its own settings page: see
  [desktop.md](desktop.md).
- [ ] The deployed apps' origins in `ORIGINS`, once they're deployed.
- [ ] A webview instead of the default browser, maybe: on Linux it would bring back GTK (webkit2gtk), which the tray
  avoids.
- [x] **Pairing**: the node's settings show a QR code ("Devices"), list the paired devices and forget them; the
  node does the rest (`crates/node/src/lan.rs`, `pairing.rs`).
- [x] **Android** ([android.md](android.md)): the gestalter in the system WebView over the notes in the app's
  storage (`gestalts_device`), pairing by QR code, syncing while the app is in the foreground, the
  `gestalter-android` distribution, "last synced".
- [ ] Android, next:
  - background sync: WorkManager (every 15 minutes at best) calling an entry point without the WebView; the
    gestalts the merge needs are kept in the data folder already
  - release builds: a signing key, `versionCode` from the version, an `.aab` for the Play Store; and CI
  - `targetSdk` 37: ask for `ACCESS_LOCAL_NETWORK` at runtime before the first sync (it's declared already), or the
    phone can't reach the desktop
  - the camera and sign-in tabs, once a plugin needs them
  - the barcode scanner's full-screen view: maybe a frame of our own, with a cancel button
- [ ] Release builds of the desktop app on macOS and Windows runners (their tray and event-loop code is untested),
  and code signing.
- [ ] CI.
