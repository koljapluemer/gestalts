# A hosted app for teachers: discussion

Not built. Where the thinking stands, from a discussion on 2026-11-16 and 2026-11-17.

## What it is

A website where teachers (school teachers, on accounts an admin gives out for now) make interactive learning
experiences for their class with an agent, and publish them to their students behind a link. It starts out as
learning-workshop, hosted, and drifts from there: publishing to students, sharing with colleagues at the same school,
and later a flow where a teacher offers a lesson for loops-for-learning, which an admin reviews and integrates.

The product is the new view. Teachers come for bespoke interactive experiences, not quiz content on stock views, so
everything below optimises for making, running, versioning and reviewing new views.

What changes against learning-workshop is that it stops being a single-user tool on its author's machine:

- the agent runs on our server, on our money
- code an LLM wrote runs on children's devices
- the kit, `@gestalts/view` and `@gestalts/learning` become a public API that code we didn't write depends on
- content moves from "used in my class" to "published"

## Where it sits

Its own app in `apps/`, not a mode of learning-workshop. What both need moves into a package: `Preview`, `Chat`,
the draft format (`workshop.ts`) and the agent protocol client. learning-workshop stays the local tool (CLI agent,
promotion into the checkout); the teacher app takes on schools, sharing and quotas.

## The draft

A rich view needs data shapes of its own, so a draft is more than `view@1`: a view, its gestalt definitions, its ymls
and blobs. `workshop-integration.md` already calls this a distinct multi-file draft model rather than extra fields on
`view`; here it is the core format, and the first decision.

Its definitions are `gestalt@1` ymls ([[gestalt-definitions-as-data|Gestalt definitions as data]], option 4), in a
namespace the server assigns per teacher or per lesson. A draft records the runtime version it targets.

## The server

A sync peer, an agent runner and publishing. Not the node, hosted.

- **Teachers' ymls**: the browser keeps its wasm repo and syncs over the node's `/sync/*` routes, scoped by account.
  The browser is untrusted here: the server validates every write with `crates/core` and enforces quotas (ymls, blob
  bytes).
- **A small relational database** for what isn't personal plain-text data: accounts, schools, shares, publications,
  short codes, submissions and their review.
- **The agent**: not `claude -p` subprocesses on a shared machine (a subscription may not serve others anyway), but the
  API with an API key and a tool loop over virtual files: read, write and edit the draft's files, `check` as a
  deterministic service (compile and typecheck in a worker or container), and the kit's sources as a fixed,
  prompt-cached corpus. No filesystem and no Bash, so nothing to escape and no other tenant to read. Turn, events and
  cancel stay as the workshop's protocol has them.
- **Seeing what it built**: compile and typecheck say little about an interactive view. The server renders the draft
  headless and gives the agent screenshots and runtime errors (the visual feedback in
  `apps/learning-workshop/doc/local-agents-and-pattern-foundry.md`). That costs per turn, so budgets per account,
  concurrency limits and prompt caching come with it.
- **Auth**: admin-made accounts behind OIDC, so school logins can plug in later.
- **Hosting** in the EU; published lessons on a CDN, also in the EU.

## Publishing to students

### A lesson is data, not a build

One static **player** per runtime version: React, the kit, learning and the frame host, content-hashed and immutable.
Publishing uploads only the lesson: the compiled view, its definitions and ymls (`ymls.json`), its blobs, its npm
packages, and a manifest (`runtime`, `reads`, `writes`, title). No build per lesson, and a published lesson never
breaks when the kit moves on, since it pins its runtime. The same format is a candidate for loops itself to load views
without a redeploy ([[deck-authoring|Deck authoring]]'s catalog).

### npm packages without a CDN

Today a view's npm imports go to `https://esm.sh/<name>` (`packages/host/src/frame/boot.ts`): unversioned, so
"latest" at the time of the request, from a third party that sees every student's IP (personal data under the GDPR),
and blocked by many school firewalls.

Instead the server does esm.sh's work itself. An endpoint like `GET /npm/three@0.170.0` fetches the package from the
registry (without install scripts), bundles it with esbuild (`react` and `react-dom` external, splitting on), and
caches it by version and hash. The preview uses it while editing, and the draft records the versions it resolved.
Publishing freezes them: the files go next to the lesson, shared between lessons by version and hash, and the
manifest's import map points there. A student's device then only talks to the lesson domain.

Packages that fetch more at run time (wasm, workers, fonts, model weights) aren't captured by bundling. The publish
check flags the common cases, and the frame's CSP (below) blocks the rest, visibly in the preview. A curated set of
prebuilt packages shipped with the player (three, d3, tone, matter, katex…) can sit beside this for what most views
use.

### The link

- **A capability link**: `https://<lesson domain>/l/<id>`, `id` about 128 random bits. Whoever has it can open the
  lesson; it's unlisted, not secret. `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, nothing meaningful in
  the path, rate-limited not-founds.
- **A QR code and a short code** for the classroom: shown on the projector, short-lived (a lesson, a day),
  rate-limited, resolving only to the long link.
- **Revoke and rotate**: one small lookup that isn't static, `id → current manifest`, at the edge or on the server, so
  a teacher can switch a link off, replace it, or let it expire.
- The link names the lesson, and its manifest the current version, so a fix during class reaches everyone.
- Later, if forwarded links matter: a passphrase, or a key in the URL fragment with the lesson encrypted at rest.
  Real access control comes with student accounts or LMS logins (LTI 1.3 and the German school platforms).

### Students' data

Stays on the device: one local repo per lesson on the lesson origin, keyed by lesson, not version. A new version that
changes the lesson's gestalts must still read the old ymls or start fresh and say so; publish compares the two and
warns. The player is a PWA, so a lesson opened once survives the school wifi.

Results for the teacher mean student accounts, minors' data, a DPIA and school contracts: a separate, deliberate
project, not a feature.

## Security

- **The lesson domain is a different registrable domain** from the app's, so nothing published shares cookies or
  storage with teachers' sessions.
- **The frame has no CSP today**: `FrameView.tsx` sets the sandbox and `srcdoc`, nothing else. An opaque-origin frame
  can still `fetch()` any CORS-enabled server and load images from anywhere, so whatever a student types can leave.
  Published and shared views get `connect-src 'none'`, and `img-src` and `media-src` limited to the lesson's own
  files.
- **`reads` and `writes` widen without a prompt** in the workshop. Fine for its author; not when a colleague runs a
  shared view against their own data. Opening someone else's view shows what it declares and asks.
- **Never for teacher code**: `same-origin` grants, `backend.py`, and `llm` in published lessons (our money, and
  minors talking to a model). The player refuses them.
- **Limits** on definitions (depth, fields, size), ymls and blobs, enforced by the server.

## Schools and sharing

Every draft, lesson and publication has an owner and a school from the start, even before the UI uses it. Sharing
with a colleague is a copy that records its origin, like the workshop's remix; never live co-editing, which would
need permissions per yml. Later a school library is a read-only layer under a teacher's folder, as decks are now.

## Offering a lesson for loops

A submission: a snapshot of the draft with its origin hash, a description, and a licence grant accepted with it. It
lands in a review queue in the same app:

1. the deterministic gates of `apps/learning-workshop/doc/workshop-integration.md`, plus actual against declared
   network use, imports, bundle size, and a performance budget on a low-end device profile
2. an AI review of kit and gestalt usage, advisory only
3. a human, on the diff and on what it may read, write and reach

Accepting runs `promote()` into a branch of the monorepo; CI reruns everything. Two things are real work there, not
checks:

- **Concepts** a teacher made have to map onto loops' own, or what learners know splits in two.
- **Namespaces**: the lesson's gestalts move from the teacher's namespace into a canonical one.

Updates come back as new submissions against the recorded origin hash, never as sync. Content made for a class isn't
automatically publishable: § 60a UrhG covers using textbook material in class, not publishing it, so the teacher
affirms the rights on submit and review looks for it.

## Footguns

- **Kit changes** break code we didn't write. Published lessons pin their runtime; drafts record theirs; a runtime
  bump offers an agent turn that migrates a draft, with `check` as the judge.
- **Safari deletes script-written storage** after 7 days without a visit, so progress kept on the device is lost over
  a holiday: ask for persistent storage, offer an export, say so in the UI.
- **Shared devices**: class iPads and Chromebooks show the next student the last one's progress. A per-lesson "start
  fresh" or "who are you", without accounts.
- **School hardware**: a three.js view that's smooth on a laptop can be unusable on an old class iPad. A device budget
  in the agent's contract and in the checks.
- **Personal data in content**: teachers paste names, class lists and screenshots, which go to the model provider.
  A processing agreement, a line in the terms, and retention for what the agent sees; the workshop's `raw/` run logs
  are kept forever locally and mustn't be when hosted.

## What comes first

From the roadmap:

- [[gestalt-definitions-as-data|Gestalt definitions as data]]: option 3, then option 4's core (`gestalt@1`, load order,
  reindexing, refusing redefinitions, limits, the structural/presentational split, definitions don't merge).
  Collisions between authors are settled by server-assigned namespaces and by promotion, not by a general rule.
- From [[concept-model|Concept model]], the structural changes (`in` on `concept`, `concepts` on `deck`) and the
  shape `useBeliefs` returns are built (2026-11-17). `closed` would be `concept@4`.
- [[deck-authoring|Deck authoring]] isn't needed. Its schema editor and catalog matter later, for editing a view's data
  in forms and for submissions.

Not on the roadmap before this, and blocking more:

- the shared workshop package
- the player and the lesson format
- the frame CSP
- npm packages from our own origin, pinned
- versions on the view contract and the kit

## Order

1. Locally: the shared package, the player and lesson format, the CSP, npm from our own origin. learning-workshop
   can publish lessons this way already.
2. Hosted: admin-made accounts, the sync store with validation and quotas, the agent loop with headless feedback,
   publishing with links, codes and revocation.
3. Schools: owners and schools in the UI, sharing as copy, a school library.
4. Submissions: the queue, the gates, concept and namespace mapping, `promote()` into a branch.
5. Perhaps: results for teachers, with student accounts.
