# App icons

All apps currently use the orange diamond in `assets/icon.svg`. Web apps copy it to `public/favicon.svg`; the desktop
and Android packages use PNGs rendered from the same source. `mise run icons:check` runs before production builds and
packaging so a missing or stale reference fails early.

To give one app its own icon later, add a square SVG as `<app>/icon.svg` (for example
`apps/vizint/icon.svg` or `apps/node/desktop/icon.svg`) and run:

```sh
mise run icons
```

The script falls back to `assets/icon.svg` for apps without an override. It needs `rsvg-convert` from librsvg; the
repo-managed Tauri CLI renders the platform-specific Android set. Commit the source SVG and generated files. Keep
important artwork away from the edges: Android launchers mask icons into different shapes.

The web favicon paths live in each app's `index.html`. Native consumers are declared in
`apps/node/desktop/Cargo.toml` (installers, Linux application icon and tray icon) and
`apps/node/android/tauri.conf.json` (Android bundle).
