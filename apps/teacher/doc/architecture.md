# Teacher app architecture

```
apps/teacher/src/          the app: sign-in, drafts, the workbench, publishing
apps/teacher/worker/       Node beside the server: compile and check a view, bundle npm packages
apps/player/               runs a published lesson from its link
crates/teacher/            gestalts-teacher: the API, the agent, publishing, the lesson domain
packages/workshop/         shared with learning-workshop: drafts, Preview, Chat, the job protocol, the agent template,
                           the lesson format (lesson.ts)
packages/npm-bundle/       npm packages bundled and pinned, without a CDN
deploy/teacher/            the box: Caddy, systemd, backups
```

## A draft

A `view@2` yml and its `members` (`packages/workshop/src/draft.ts`): `gestalt@1` definitions named in the draft's
`package`, which the server hands out, and the ymls it ships with. Each draft is its own folder, in the browser (OPFS,
`teacher-draft-<id>`) and on the server (`drafts/<id>/`), synced over the node's `/sync` and `/blobs` shapes under
`/api/drafts/<id>/`. The browser is untrusted: the server validates every write with the core (`validate.rs`): valid
by the core's, the model packages' or the draft's own gestalts, definitions only in its package, one view, the
quotas. A refused write shows as "Not saved" in the workbench.

## The agent

On the server, on our API key (`agent.rs`): a tool loop over the draft's files held in memory. Its tools read and
write `view.tsx`, `view.json`, `gestalts/` and `data/`, read and search the kit's sources and the examples of the agent
template, and run the check (the worker: the template's `check.ts` plus npm pinning). No filesystem, no shell. The
contract is the template's `CLAUDE.md` with a preface, cached. Turns use the workshop's job protocol, so `Chat` is the
same as learning-workshop's; the browser writes the files a turn hands back. One turn at a time per teacher, within a
monthly token budget (`turns` in the database). Conversations live in the server's memory for a day.

## Previewing

The preview runs the view under `closedCsp`, as the player does: nothing reaches a server, npm packages come from
`/api/npm/` at the versions `view.json` pins (bundled on demand by the worker), so what breaks in a lesson breaks in
the preview first.

## Publishing

`publish.rs`: the draft as the server has it is checked (compiles, npm pinned and bundling, gestalts a lesson has,
every member valid, a player installed for the draft's runtime, published gestalts keep their structure), then written
as a version folder named by its content: `lessons/<lesson>/<version>/` with `manifest.json`, the compiled view, and
its ymls as a published deck. npm bundles go to `npm/`, shared. A draft has one publication, so its link stays across
versions; unpublishing switches it off (410).

## The lesson domain

A different registrable domain (`lessons.rs`). `/l/<lesson>` serves the player build of the lesson's runtime with a
`<base>`, `/l/<lesson>/current` names the current manifest, everything else is immutable files. No indexing, no
referrer, and many not-founds a minute are answered with 429. The player keeps a student's data on the device, one
OPFS folder per lesson, with "start fresh" for shared devices.

## Not yet

Headless screenshots for the agent, QR and short codes, rotating a link, an offline player, schools and sharing in
the UI, submissions for loops, OIDC sign-in, results for teachers. See [[../../../doc/roadmap/teacher-app|the roadmap]].
