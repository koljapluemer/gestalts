# Android

An app on a phone: its page in Android's system WebView (Chrome), with the same host and plugins as on the desktop.
The ymls are kept on the phone and synced with the gestalts-node it paired with, while both are on the same Wi-Fi.

The shell (`apps/node/android`: storage, sync, pairing, the commands) is the same for every app; which page it wraps
is a build input, `GESTALTS_ANDROID_DISTRIBUTION` (from the repo root, default `apps/gestalter/distribution-android`,
the gestalter). The Android tasks pass it to Tauri as `--config` (`scripts/android-distribution.sh`). The app's id
and name (`tauri.conf.json`, the Gradle project in `gen/android/`) are still the gestalter's: a second Android app
needs its own.

```
apps/node/android/        the app: Tauri 2 (a Cargo workspace of its own, so the desktop never builds Tauri)
  src/lib.rs              commands and events between the page and gestalts_device
  src/android.rs          JNI: the multicast lock for mDNS, the phone's model to pair under
  tauri.conf.json         id com.koljasam.gestalter, the page from apps/gestalter/distribution-android/dist
  capabilities/           what the page may call: core events, the barcode scanner (the app's commands are allowed by default)
  gen/android/            the Gradle project (`cargo tauri android init`, then edited: SDK levels, permissions)
apps/gestalter/distribution-android/  the page: distribution `gestalter-android`, its plugins, App.tsx and Pairing.tsx
```

## How it fits together

- **The page** runs `@gestalts/host` with the plugins and the core in wasm, opened with `{native: 'tauri'}`
  (`@gestalts/client`). The core keeps the index in the page, as everywhere, but its storage is the app's folder:
  every read and write is a command (`@gestalts/client/tauri`). Opening reads every yml in one call.
- **The app** holds a `gestalts_device` (gestalts' `crates/device`) on a thread of its own. It keeps the ymls in its
  private storage (`<app data>/data`) and syncs them with the paired desktop. It tells the page what a sync changed
  (`gestalts://changed`, which the page rereads) and how syncing goes (`gestalts://status`, shown under the phone
  icon).
- **Sync** runs on pairing, when the app comes to the foreground, 0.8 s after a write, and every 15 s while it's in
  the foreground (the page tells the app through `set_active`). Nothing syncs while the app is in the background.
- **Pairing**: in gestalts-node's settings, "Pair a device…" shows a QR code. On the phone, open the phone
  icon and choose "Scan pairing code" (or paste the code). The phone then reaches the desktop over TLS pinned to its
  key, first at the address that worked last, then by mDNS. While it looks, it holds a Wi-Fi multicast lock (Wi-Fi
  drivers drop multicast packets without one). "Forget" ends it on the phone; remove the phone on the desktop too.
- **Left out**: backends. The node's services aren't reachable from a phone, so views needing one are hidden.

### Commands

The contract between `@gestalts/client/tauri` and `apps/node/android/src/lib.rs`:

| command | args | returns |
|---|---|---|
| `ymls_list`, `ymls_read_all`, `ymls_hashes` | | keys, `[key, text][]`, `{key: hash}` |
| `yml_read`, `ymls_read` | `key`, `keys` | text or null, `[key, text][]` |
| `yml_write`, `ymls_write`, `yml_delete` | `key, text`, `notes`, `key` | |
| `blobs_list`, `blob_delete` | `name` | names |
| `blob_read` | `name` | raw bytes: a byte 1 then the blob, or a single 0 if missing |
| `blob_write` | raw bytes, header `x-blob-name` (URI-encoded) | |
| `gestalts_set` | `yaml` (the plugins' gestalts, kept for merging) | |
| `sync_status`, `sync_now`, `set_active` | `active` | the status (`gestalts_device::Status`) |
| `pair`, `forget` | `uri, deviceName?` | `{nodeId, name}` |

## Building

Needs, besides what the desktop needs:
- the Android SDK with platform 36 and build tools, and the NDK `28.2.13676358` (Android Studio's SDK manager, or
  `sdkmanager --install "platforms;android-36" "ndk;28.2.13676358"`). `scripts/android-env.sh` finds them at
  `ANDROID_HOME` (by default where Android Studio puts it) and `NDK_HOME`.
- a JDK 17 or newer for Gradle.
- the Rust Android targets, which `rust-toolchain.toml` lists (rustup adds them), and the Tauri CLI, which
  `mise install` pins.

```sh
mise run android:dev     # on a phone with USB debugging (or an emulator); the page hot-reloads from this machine
mise run android:build   # a debug APK for arm64 phones: adb install -r gen/android/app/build/outputs/apk/…/app-…-debug.apk
mise run android:check   # clippy for arm64 Android
```

For an emulator, build for its architecture: `cd apps/node/android && source ../../../scripts/android-env.sh && source
../../../scripts/android-distribution.sh && cargo tauri android build --debug --apk --target x86_64 --config
"$(distribution_config)"`. In a desktop browser (`pnpm --dir apps/gestalter/distribution-android dev`), the page keeps
the notes in the browser and shows no pairing, which is enough for layout work.

The SDK levels are 36 (`apps/node/android/gen/android/app/build.gradle.kts`). At 37, Android blocks the home network unless the app
asks for `ACCESS_LOCAL_NETWORK` at runtime. The manifest declares it already, but nothing asks for it yet.

Release builds need a signing key and aren't set up yet ([next-steps.md](next-steps.md)).
