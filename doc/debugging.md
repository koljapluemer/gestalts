# Debugging

The apps keep a **debug log**: structured events from the repo, the learning layer and the perspectives, recorded into an in-memory ring buffer (the last 2000 events) whether or not anyone looks. Nothing leaves the page. A reload empties it.

## Reporting a problem

1. Reproduce it.
2. Click the bug icon in the navbar. It copies the log as JSON. Without clipboard access (plain http, some mobile browsers) it downloads `gestalts-debug-<time>.json` instead.
3. Paste or attach it to the report.

The icon turns red once an error was logged, and amber while something has been running too long.

The snapshot holds `open` (spans still running, with their age) and `events` (oldest first): `{ t, scope, level, msg, data }`. Strings in `data` are cut at 500 characters. Notes are logged by key, never by content.

## Console output

Off by default. Warnings and errors always go to the console. To see more, in the devtools console:

```js
localStorage['gestalts:debug'] = 'repo,learn'   // or '*'
```

then reload. `delete localStorage['gestalts:debug']` turns it off.

## Scopes

| scope | what |
|---|---|
| `repo` | `open`; every mutation (`putValue`, `putRaw`, `delete`, `writeBlob`, `sync`) as a span, with how long it `waitedMs` behind the ones before it; `changed` (version); connect, disconnect, sync failures; `sync done` with note counts and ms per step (`health`, `open_base`, `read_local`, `read_remote`, `read_base`, `merge_notes`, `blobs`, `pull_upstream`, `reindex`); `sync: coalesced` when a sync request joins one already waiting |
| `practice` | `saveReview` (state write + session trial) as a span |
| `learn` | `rate`, `rated` (when the background save is done), each `pick` (slot, counts); a warning if the card just rated comes up again |
| `greek` | `rate`, `rated` (with the next card) |
| `demo` | deck updates found on open |
| `ui` | render errors caught by a pane's error boundary, with the component stack |
| `global` | uncaught errors and unhandled promise rejections |

## Spans and hangs

`logger(scope).span(msg)` logs `msg: start`, and `msg: end` or `msg: failed` with `ms`. An end after 2 s is logged as a warning. A span still open after 2 s, 10 s and 30 s logs `msg: still running after Ns`, so a hang shows up while it lasts. A write stuck behind a slow `sync` appears as a long-running `sync` span and the write's `queued` line, then its large `waitedMs`.

## Adding logs

```ts
import { logger } from '@gestalts/sdk'; // the host's code may also use @gestalts/client
const log = logger('my-scope');
log.info('did a thing', { key });
const span = log.span('slow thing', { key });
try { await work(); span.end(); } catch (e) { span.fail(e); throw e; }
```

Log decisions and the boundaries of async work, not every render. Pass keys, ids and counts, not note text.
