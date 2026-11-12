# Folding gestalt-workshop into Loops for Learning

Status: consolidation implemented; promotion roadmap deferred

The standalone Workshop UI, local backend, agent template, scripts, checks and documentation now live in
`loops-for-learning`, with Learn and Make modes. The fold intentionally preserves `view@1`, `workshop-views`, the
`WORKSHOP_*` environment variables and the local agent protocol so existing drafts and sessions require no migration.
The promotion, remix, source-root, worktree and GitHub sections below remain design notes rather than implemented
features; source-to-draft remixing is explicitly out of scope for this consolidation.

## Summary

`gestalt-workshop` has mostly become an authoring environment for Loops for Learning views. It should therefore become
the **Make** mode of `loops-for-learning`, while the existing application remains its **Learn** mode. The shared Gestalts
repository should continue to own the generic view runtime, compiler, host, data model and plugin contracts.

The fold is mostly a product and repository consolidation. It does not require inventing a new view runtime:
vibecoded and source views already run through the same frame contract. A workshop draft is nearly the same artifact as
a source plugin:

| User-space draft | Source plugin |
|---|---|
| yml identity | plugin directory and `id` |
| `title` | `plugin.yml:title` |
| `reads` | `plugin.yml:reads` |
| `writes` | `plugin.yml:writes` |
| `source` | `view.tsx` |
| — | `version`, `tags`, capabilities and distribution grants |

The important design decision is to treat transfer as an explicit **promotion**, not as continuous synchronization.
User-space yml is personal, editable draft state. A plugin directory is maintained application source.

## Proposed repository shape

```text
loops-for-learning/
  src/
    app/                    learner-facing Loops shell
    workshop/               view list, chat, preview and promotion UI
  plugins/
    workshop-agent/         local-only authoring backend
    <loops-owned plugins>/  promoted views specific to Loops, when useful
  agent-template/           contract and checks used by the drafting agent
  scripts/                  local node, checks and reports
  distribution.yml
```

The exact directory names are not important. The ownership boundary is:

- Loops owns the authoring experience and the learning application.
- `gestalts` owns generic execution, compilation, schemas, APIs and reusable packages.
- Views useful to several applications may remain in `gestalts/plugins` or `gestalt-plugins`.
- Views specific to Loops may live beside the application, avoiding an unnecessary third-repository hop.

The public application can expose the Workshop UI without promising that every authoring capability is available.
Preview and manual editing can work in a browser. Chat with the CLI agent and direct writes into a source checkout need
a connected local node. The UI should expose these as capabilities rather than assume them.

## Product modes

### Learn

This is the current Loops experience: source plugins from the distribution, one learning view at a time, with browser
storage and optional synchronization.

### Make

This is the current Workshop experience: user-space `view` ymls, a live preview and a conversation that edits one view.
It should use the learner's actual repository, so an author can try a view against real data without first publishing
source code.

Make mode should remain useful without an agent:

- edit and preview a draft;
- import or remix a source plugin;
- run local checks;
- download a source-plugin bundle;
- inspect promotion differences.

Agent backends are replaceable enhancements. Claude CLI can remain the first capable implementation, while local-model
and other providers can be added later.

## Draft and source lifecycle

Use an explicit, one-way lifecycle with an explicit return path:

```text
source plugin --fork/remix--> user-space draft
                                  |
                              edit and test
                                  |
                           promote/export
                                  v
                              source plugin
```

Do not silently keep both representations synchronized. Once source and draft are independently editable, automatic
two-way synchronization becomes a bespoke merge system hidden inside the view format.

Instead:

1. **Edit in Workshop** forks a source plugin into a new draft.
2. The draft records the source revision and content hash it came from.
3. **Promote** compares the draft with that base.
4. Promotion creates or updates source files through an inspectable diff.
5. If source has moved, the user explicitly refreshes or rebases the draft.

This also makes remixes natural: a remix has a new draft identity and may later become a new plugin rather than an
update to its origin.

## Draft format

`view@1` is sufficient for the first exporter. Promotion eventually needs identity, capabilities and provenance, so a
`view@2` can add them without making all fields mandatory at creation time:

```yaml
gestalt: view@2
title: Phrase drills
source: |
  export default function View() { ... }

reads: [flashcard@1, concept@2]
writes: [practice-event@1]

plugin:
  id: phrase-drills
  tags: [learning]
  version: 0.1.0

capabilities:
  network: []
  llm: false
  permissions: []

origin:
  repository: loops-for-learning
  path: plugins/phrase-drills
  revision: 8f31ab
  source_hash: sha256:...
```

The format should continue to represent a single-file view. Backends, decks, new gestalt definitions and arbitrary
plugin files cross a useful complexity boundary. If Workshop later authors whole plugins, that should be a distinct
multi-file draft model rather than extra source files concealed in `view` fields.

## Deterministic promotion

Implement promotion first as a pure conversion:

```ts
promote(view): {
  'view.tsx': string;
  'plugin.yml': string;
}
```

`source` becomes `view.tsx` unchanged. The manifest is generated from the remaining fields. The same function should
power:

- download as files or a zip in any browser;
- a local CLI;
- node-assisted writes into a checkout;
- tests of the conversion;
- a later GitHub pull-request workflow.

Keeping this conversion pure prevents browser, backend and CLI exporters from developing different rules.

## Writing into a local checkout

A browser should not give an agent an arbitrary filesystem path. The node can be configured with named source roots:

```yaml
source_roots:
  loops: /home/me/code/loops-for-learning/plugins
  shared: /home/me/code/gestalt-plugins
```

Promotion requests name a root and safe plugin slug, include the expected base hash, and contain only the generated
files. The backend must:

- resolve and verify that the destination remains below the configured root;
- refuse unsafe plugin identifiers;
- detect a stale base before overwriting an existing plugin;
- return the prospective diff before writing;
- write files atomically;
- never commit, push or open a pull request without a separate explicit action.

A Git worktree is a good later implementation for preparing and building a branch without disturbing the developer's
current checkout.

## Promotion gates

A Workshop preview succeeding is necessary but not sufficient to ship a plugin. Promotion should distinguish three
levels:

1. **Draft valid**: it compiles and runs in Workshop.
2. **Promotable**: its manifest, imports and capabilities fit the source-plugin subset.
3. **Distribution valid**: it passes Loops' real production build, grants and environment.

The promotion pipeline should run:

- the same compiler used by source views;
- TypeScript and manifest checks;
- inference and comparison of actual versus declared reads, writes, network and npm use;
- production rules such as the `learning` tag;
- capability checks, including `same-origin` restrictions;
- focused fixtures or view tests when present;
- the Loops production build.

Changes to reads, writes, network access or elevated permissions should be shown prominently. The current Workshop lets
the drafting agent widen reads and writes without confirmation; source promotion is the latest point at which that must
become an explicit human decision.

## Source-to-draft remixing

Every source view in Loops should eventually offer **Remix in Workshop**. It copies the source and supported manifest
fields into a new draft and records its origin hash. This creates a useful product loop:

```text
use a learning view
-> notice a possible improvement
-> remix it against real data
-> promote it
-> inspect the source diff
-> ship it
```

Unsupported plugin features should be reported during import rather than silently discarded.

## GitHub pull requests

GitHub is a useful publication boundary, not a required storage or execution layer. The complete workflow should work
locally first:

1. Promote into a branch or worktree.
2. Run checks and the production build.
3. Inspect and edit the diff.
4. Commit locally.
5. Optionally push and open a draft pull request.

The pull request can summarize capabilities, checks, review findings and deliberate exceptions. It must not contain
private learning data, raw agent conversations or local model traces. CI should rerun every deterministic check; local
AI reviews can be attached as advisory evidence but should not be trusted as required CI results.

## Suggested implementation order

1. Move Workshop UI, agent backend, template, checks and scripts into `loops-for-learning` without changing behavior.
2. Give Loops separate Learn and Make entry points or modes.
3. Add a pure `view@1` to `view.tsx` plus `plugin.yml` exporter and test its output with the Loops build.
4. Add browser download and a promotion preview.
5. Add source-to-draft remixing.
6. Introduce `view@2` provenance and capability fields when update-in-place is implemented.
7. Add named local source roots and guarded atomic writes.
8. Add worktree/branch preparation and optional GitHub pull requests.

This keeps the initial fold small. Local-model assistance, deeper review and ecosystem learning are orthogonal layers
described in [local-agents-and-pattern-foundry.md](local-agents-and-pattern-foundry.md).
