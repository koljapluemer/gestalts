# player

Runs one published lesson, from its link `/l/<lesson>`, on the lesson domain. One build per frame runtime, served
under `/runtime/<version>/` (`dist/gestalts-runtime.json` says which) by the teacher server, which answers every
`/l/<lesson>` with the build its current version was made against. The lesson format is in
`packages/workshop/src/lesson.ts`.

A student's data stays on the device: one OPFS folder per lesson, the lesson's ymls mounted read-only under it. "Start
fresh" switches to a new folder, for the next student on a shared device. The view runs under `closedCsp`: it reaches
no server.

```sh
pnpm -C apps/player dev     # :5177, lessons from the teacher server on :7741 (VITE_LESSONS)
pnpm -C apps/player build
```

Its `models:` must be the teacher app's.
