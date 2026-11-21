# Web first: one app, the browser as home

A redesign discussed on 2026-11-20. Today's shape is several node instances (the dev node, the Make node, the vizint
node, the teacher agent node, all `gestalts-node-desktop` with different plugin sets) and eight frontends sharing
packages. The direction: one web app, the browser as the home of a user's data, an optional account that syncs it,
and whatever needs the desktop as small, optional tools. Decided below is the foundation; the rest follows from it
and is still open.

## Decided

### The browser is the primary home of a user's data

A user's ymls live in the browser (OPFS), in every browser. Real folders stop being the source of truth: export is
for everyone, a continuous folder sync is an optional tool (or `showDirectoryPicker` in Chromium).

What follows:

- the node is no longer needed to use any app; pairing, LAN sync, the tray and the uv bootstrap are no longer on the
  main path
- gestalter changes character: notes are data in an app that exports files, no longer files any tool can edit
- browser storage alone isn't durable. Safari deletes what a site stored after 7 days without interaction unless the
  app is added to the home screen or dock; others may evict under pressure (`navigator.storage.persist()` helps in
  Chromium and Firefox). Without an account the browser is a cache that can vanish, and the UI has to say so and
  point to an account, an export, or adding the app
- a "download everything" (a zip of the ymls and blobs) is required anyway: GDPR's data portability

### Accounts sync, and the server can't read what it keeps

An account exists to sync one person's data between their browsers. It has nothing to do with teachers, schools or
students for now.

The model is Firefox Sync's: the browser encrypts before syncing, the server keeps the encrypted records and can't read
them. That makes the server a backup too: a new browser downloads and decrypts, a cleared one recovers.

An expiring mailbox (the server keeps encrypted changes only until every device has fetched them, or until a
deadline) as an option for people who want nothing kept, even encrypted, is undecided. Its costs: no backup, and a new
device gets the full state only from another device or a short-lived encrypted snapshot.

What follows:

- the server can't validate synced writes; the browser does, with the core (a user's bad write only hurts them)
- the server can't compute anything from the data; anything a teacher would ever see is something the user sends on
  purpose, separately
- the key: a lost key is lost data, so recovery (a recovery key, a passkey, a second device) is part of the design,
  not an afterthought
- the server still sees metadata: that an account exists, its devices, when they sync, how much changes. The privacy
  policy says so

### The data model stays as it is

Gestalts, versioned definitions, one yml per record, blobs, and `crates/merge` for concurrent edits: unchanged, for
an easy migration. What changes is where the records are kept (the browser) and how they travel (encrypted sync),
not what they are.

Kept in mind, not planned: if machine-written records (practice events) grow too many, per-device append-only logs
merged by union avoid both the volume and every conflict on them; and keeping derived state (`fsrs-data`) rebuildable
from the events it comes from keeps the learning model free to change.

## Built

Step 1, on 2026-11-21: one web app to run and test, locally (`web/app`, see
[[../architecture/system-overview|Architecture]]). The separate frontends of gestalter, loops-for-learning, vizint,
both workshops and the teacher app are its areas (paths); notes, learning and visualizations share one home store in
the browser; `mise run just dev` starts the app, one node (the agents, plugin backends, the workshops' drafts; split in step 2)
and the teacher server. Item 7 is taken as a single-page app for now. Deploying it is not done: the old sites keep their last
deploy, and `scripts/deploy.sh` is gone.

Step 2, on 2026-11-21: the repo split by where things run. `web/` is the web app (`app/`), the lesson player, the page
the Android app wraps and the server; `installables/` the two desktop tools of item 9 as separate binaries on
`crates/node`: `folder-sync` (gestalts-node as it was: tray, settings, pairing, the Android app; plugin backends,
`/net`, `/llm`) and `claude-bridge` (the agents and the workshops' drafts, :7737; not packaged yet, it runs from a
checkout). `mise run just dev` starts both.

## Open, in order

1. **Sync: storage or mailbox.** Decides whether the server is a backup, and how a new device gets its data.
2. **The key.** Derived from a password, a passkey (the PRF extension), or a generated key with a recovery code; and
   what is encrypted as a unit (a record, a batch of changes), which decides how much metadata the server sees.
3. **Sign-in.** Passkeys, email, or both; an email is personal data the server would otherwise not hold.
4. **The trust model for view code.** Leaning: strict frames only, and the host owns embeds and devices. A view asks
   the host for a YouTube player or a recording, the host renders the embed in its own origin and drives it over the
   bridge; no view gets `same-origin`. Plus a pinned library allowlist (what `view.json` and `packages/npm-bundle`
   already do for npm). Open: declarative views (yml composed from vetted components) as the default for agent output,
   code as the exception.
5. **Domains.** With 4, frames need no hostname. Left: published lessons are user content on our domain (phishing,
   blocklisting), files users made served from our origin need `Content-Security-Policy: sandbox` and `nosniff`, and
   same-site sandboxed frames may share the app's process (a hung view freezes the app). One app origin plus a plain
   domain only for user content covers all three.
6. **Runtime versioning.** Today a lesson pins a whole player build by a hash of the frame runtime's JS (CSS isn't in
   the hash). Leaning: the frame runtime (React, the kit, `view`, `learning`, `sources`) versioned as one, by semver
   majors; the player shell always current; a lesson's CSS compiled at publishing; a published version keeps its
   source.
7. **Frontend structure.** One project: an Astro site with the apps as client-only areas, or a single-page app with a
   prerender script. Decided by how much public content there will be (CMS, docs, public decks). Shared by both sides
   and owned by neither: the kit (with the app's components apart from the API views get) and the frame packages.
8. **Server scope.** What stays central: accounts and sync, publishing and the lesson domain, the hosted agent.
9. **Desktop tools.** Small and optional, each released on its own: Claude Bridge (native, it runs a CLI), Sync to
   Folder, YouTube subtitles, imports. A browser extension where it can do the job (cross-origin fetches, store
   installs and updates, no signing); a native tool speaking one localhost interface to the app's origin where it
   can't.
10. **Migration.** What users carry over: browser data on the old origins (`loop.koljasam.com` and the others),
    gestalter folders into the browser and an account. What is dropped: the node instances on the main path, the
    separate app sites. The order of work.
