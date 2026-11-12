# Local agents, deterministic assistance and a pattern foundry

Status: exploration and staged proposal

## Purpose

Loops for Learning should eventually span a wide range of human knowledge and allow domain experts to create and
iterate their own interactive learning views. Two related problems follow:

1. Make view generation, review and repair affordable enough to run frequently, including with local models.
2. Let shared schemas, APIs and UI facilities emerge from successful expert work instead of imposing one early,
   top-down conception of learning interaction.

These goals reinforce each other. Structured knowledge and deterministic tools make small models more capable; the
same observations can reveal recurring patterns across independently authored views. The system should therefore be a
laboratory, an observatory and, only after evidence accumulates, a foundry for shared abstractions.

## Working assumptions

- An 8 GB GPU can run a useful 7--8B quantized coding model fully or mostly on GPU.
- With roughly 30 GB of system RAM, larger quantized models can be partially offloaded and run slowly for occasional
  overnight work.
- Small models are much better at a localized transformation with exact APIs and feedback than at open-ended repository
  exploration.
- Claude CLI currently performs well partly because it can discover the repository, infer conventions, recover from
  mistakes and make product decisions. Those jobs should be separated where possible.
- Model output is never the correctness boundary. Compilation, schemas, policies, fixtures and human review are.

The near-term goal is not necessarily to replace Claude. It is to reduce expensive exploration and routine repair, make
common view archetypes locally generatable, and escalate only ambiguous or novel work.

## The division of labor

```text
deterministic tools
  find facts, candidates, violations and behavioral differences

local model
  interpret intent, choose among candidates and adapt a focused patch

strong remote model
  resolve ambiguity, invent novel interactions and handle repeated local failure

human/domain expert
  decide pedagogy, permissions, ontology and publication
```

The useful promise is not "a local model autonomously improves the repository." It is "a local model proposes a
focused change and the system can establish whether that change is admissible."

## One knowledge surface for generation and repair

Generate a machine-readable catalog of public facilities from TypeScript exports, types, JSDoc, gestalt definitions,
source usages and selected examples:

```json
{
  "symbol": "NoteEditor",
  "module": "@gestalts/kit",
  "signature": "NoteEditor({ note, onDone })",
  "purpose": "Create or edit a note using the standard note form",
  "useWhen": ["A view edits the complete note@1 shape"],
  "doNotUseWhen": ["Only a title is being collected"],
  "requires": { "reads": ["note@1"], "writes": ["note@1"] },
  "canonicalExamples": ["plugins/note-crud/view.tsx"],
  "replacesPatterns": ["manual note form", "manual alias serialization"]
}
```

Mechanical facts should be generated. Semantic intent must be curated near the implementation:

- what problem the facility solves;
- when and when not to use it;
- behavior it already centralizes;
- data and capability implications;
- canonical examples and counterexamples;
- superficially similar facilities and their differences.

The catalog supports both directions:

```text
generation: intent terms -> relevant facilities and examples
repair:     code patterns -> likely existing replacement
```

## Retrieval

Do not rely on embeddings alone. Code provides stronger signals:

- symbols, definitions and references;
- imports and type compatibility;
- JSX and AST shapes;
- hooks, gestalt names and query shapes;
- repeated field normalization;
- existing canonical usages;
- behavioral traces from fixtures.

Use hybrid retrieval:

```text
AST/type signals + lexical search + catalog metadata + graph relations + embeddings
```

Embeddings are valuable for fuzzy intent and rationale. They should rank within structurally plausible results rather
than decide whether two APIs are compatible.

## Deterministic agent tools

Implement the intelligence as a normal library and stable JSON CLI, then expose the same operations through Workshop,
CI and an optional MCP server. MCP provides interoperability; it should not be the only home of important logic.

High-value tools include:

- `catalog.search`: find facilities from an intent or pattern.
- `catalog.explain`: return the full contract, examples and pitfalls for a symbol.
- `schema.describe` and `schema.diff`: return exact fields, validation and migrations.
- `code.find_equivalents`: rank existing facilities for a selected source region and report explicit matching signals.
- `code.manifest_usage`: infer proven and possible reads, writes, network, npm and other capabilities.
- `patch.check`: compile, typecheck, validate manifests, run policies, fixtures and the production build.
- `view.run_fixture`: execute a named scenario and return DOM, layout and host-call observations.
- `patch.compare_behavior`: compare queries, writes and state transitions before and after a migration.

A model should receive compact structured diagnostics, the relevant signature and one good example, not an unfiltered
compiler transcript followed by unrestricted filesystem exploration.

## Executable policies and change recipes

Architecture should not live only in prose. Encode mechanically observable rules where possible:

- live queries are bounded;
- a view cannot query raw practice events to calculate displayed knowledge;
- observed capability use matches the manifest;
- forbidden imports and package directions;
- custom full-screen overlays are candidates for `Modal`;
- source plugins fit distribution grants and static deployment constraints.

Rules may produce errors, warnings or advisory candidates. UI and pedagogy should usually begin as advisory; security,
data correctness and runtime boundaries can be enforced.

Recurring accepted transformations can mature into tested recipes or codemods:

```text
detector -> design intent -> proposed adaptation -> validation
```

The first few instances may need an LLM. Once the semantics and variation points stabilize, a deterministic recipe is
cheaper and more reliable. The model can select and parameterize it instead of rewriting source.

## Local repair workflow

Kit migration and other focused corrections are plausible on small models when the system localizes the task:

```text
view source
  -> AST/policy detector
  -> likely facilities plus exact contracts
  -> local model proposes one patch
  -> compile, typecheck, policies and fixtures
  -> retry with structured diagnostics
  -> verified proposal for human acceptance
```

Distinguish outcomes:

- **Finding**: a likely issue or overlap.
- **Patch**: a concrete proposed change.
- **Verified patch**: the patch passes the applicable deterministic gates.

Only the last should be presented as a ready fix. Ambiguous cross-module refactors, new abstractions, pedagogy and
concept weights should remain flag-first tasks.

## Local initial generation

Initial generation is harder than repair because the target is not localized. It runs in the reverse direction:

```text
repair:     code -> pattern -> abstraction -> patch -> validation
generation: intent -> design -> abstractions -> assembly -> validation
```

Introduce a small intermediate `ViewPlan` before generating source:

```yaml
title: Phrase practice
archetype: single-item-drill

data:
  primary:
    gestalt: flashcard@1
    query: { limit: 50 }
  beliefs: { from: concepts }

states: [loading, empty, question, revealed, completed]

actions:
  reveal: { transition: question -> revealed }
  rate:
    uses: logPractice
    transition: revealed -> question

facilities: [useQuery, useBeliefs, lessonPlan, logPractice, usePracticeSession]
layout: { narrow: stacked, wide: centered-card }
capabilities: { backend: false, microphone: false, network: [] }
```

This is an internal planning representation, not another user data format. It lets deterministic tooling check basic
coherence and select a scaffold before code exists. Known archetypes can provide data access, loading/error/empty states
and contract boilerplate. The model fills interaction, language, composition and novel behavior.

Prefer staged generation:

1. Interpret intent into a plan.
2. Validate and enrich the plan.
3. Retrieve relevant facilities and examples.
4. Generate a deterministic scaffold.
5. Generate the primary interaction.
6. Compile and run fixtures.
7. Add secondary behavior and visual polish.
8. Run focused review and repair.

This makes local failure recoverable and lets a strong model receive a compact plan and diagnostics if escalation is
needed.

## Visual and behavioral feedback

Compilation does not establish that a view is usable. Browser instrumentation can report useful facts without asking a
model to judge a screenshot:

- horizontal overflow and clipped nodes;
- unlabeled controls and accessibility findings;
- whether the root fills its frame;
- target sizes and contrast;
- behavior at narrow and wide viewports;
- loading, error and empty-state rendering;
- host queries, writes and capability calls.

Screenshots and a multimodal model can supplement this, but structured layout and accessibility observations are
cheaper and easier to validate. Named fixtures should cover empty, small and large repositories, missing references,
read-only deck items, offline operation, denied capabilities and multiple viewport sizes.

## Model routing and evaluation

Use local-first routing rather than one model for every task:

- a small model for planning, known archetypes, localized repair and routine reviews;
- a larger partially offloaded local model for difficult overnight proposals;
- Claude or another strong provider for novel interaction design, ambiguity and repeated failure.

Escalation can be triggered by repeated validation failures, unresolved ambiguity, widened permissions or explicit user
choice. Even when escalation occurs, precomputed catalog context and diagnostics reduce the expensive model's work.

Build a small repository-specific evaluation set before depending on any model:

- historical missed-kit cases;
- clean views that must not be changed;
- ambiguous cases that should only be flagged;
- common greenfield view requests;
- fixtures that expose behavioral regressions.

Measure valid patch rate, false positives, checks passed, human acceptance, time and memory. Better retrieval, examples
and tools should be evaluated alongside model size.

## From prescribed kit to a learning ecosystem

At the intended scale, the kit should be the accumulated residue of successful expert experimentation, not a taxonomy
of learning interactions decided in advance. The Workshop should first become an observatory:

```text
independent expert views
  -> observe structures, behavior and provenance
  -> detect recurring motifs
  -> compare variants and evidence
  -> document a candidate pattern
  -> publish an experimental facility
  -> observe voluntary adoption and adaptation
  -> stabilize, split, revise or retire it
```

Early duplication is useful evidence. A warning should initially say that similar approaches exist and explain their
differences, not demand conversion to a canonical flashcard UI.

## What to observe

For every promoted or published view, derive several representations.

### Static structure

- imports, hooks and public facilities;
- gestalts and query/write shapes;
- state transitions and event handlers;
- JSX/AST structure and style clusters;
- local helpers and components;
- data transformations.

### Behavioral structure

Fixtures can record queries, writes, state transitions, accessibility trees, layout measurements, capability use and
failure-state behavior. This can reveal that syntactically different views implement the same activity motif.

### Declared intent and rationale

Authors may optionally describe their activity without being forced into a closed taxonomy:

```yaml
intent:
  teaches: recall
  activity: prompted-production
  answer_mode: self-rated
  unit: phrase
  session_shape: adaptive-sequence
```

Experts should also be able to publish assumptions, known failure modes, relevant sources and meaningful variation
points. This distinguishes popular code from a defended learning design.

### Provenance and decisions

Record remix lineage, adopted or removed facilities, accepted and rejected review suggestions, tests, migrations and
author explanations. Copies derived from one source must not be counted as independent convergence.

## Motif and overlap discovery

Mine more than duplicated text. Useful recurring motifs include:

- UI: overlay editor, searchable picker, master/detail;
- data: query, enrich, group and rank;
- learning: prompt, response, feedback and evidence;
- session: select, practice, rate and advance;
- curation: suggest, compare and bulk approve;
- schema: recurring fields, links and workarounds.

Use cheap structural fingerprints, graphs and embeddings to form candidate clusters. Only then ask a model to name the
pattern, explain shared semantics and build a variation matrix.

An abstraction is valuable when "shared facility plus concise variations" is simpler and clearer than its independent
implementations. Evaluate:

```text
duplication removed
+ independent implementations covered
+ semantic and behavioral similarity
+ repeated defects centralized
+ voluntary adoption
- configuration complexity
- exceptional branches
- coupling introduced
- meaningful variation hidden
```

Superficial resemblance is not enough. Pronunciation production and proof reconstruction may share a card-shaped UI
while having incompatible evidence semantics.

## Pattern maturity

Use a ladder rather than moving directly into `@gestalts/kit`:

```text
observed motif
  -> documented pattern
  -> optional recipe
  -> experimental helper
  -> candidate kit facility
  -> stable facility
  -> split, superseded or deprecated
```

Keep three kinds of rule separate:

1. **Infrastructure invariants**: security, schema correctness, bounded access and runtime constraints; enforce them.
2. **Protocol facilities**: interoperable evidence and data semantics; recommend strongly and stabilize carefully.
3. **Experience patterns**: UI and pedagogy; preserve plurality and present examples rather than mandates.

Consistent `logPractice` semantics can be important while six radically different practice experiences coexist.

## Exemplar selection

There should be no global "best flashcard view." Rank examples contextually using several forms of evidence:

- technical quality and survival through migrations;
- behavioral fixtures and accessibility;
- expert authorship, review and rationale;
- independent reuse and remixing;
- appropriate, privacy-preserving usage evidence;
- carefully interpreted learning evidence;
- relevance to the domain, learner, device and activity.

Retrieval should deliberately preserve diversity, for example by returning the most established, most domain-relevant,
most structurally similar and most distinct successful alternative. Discount inherited copies so early popularity does
not create a self-reinforcing monoculture.

Learning outcomes are difficult to infer and easy to confound. Engagement is not learning. Outcome data should remain
local by default and only be published through explicit, aggregated evidence with appropriate consent.

## Kit and schema proposals

A proposal agent should receive a narrowed cluster, not the whole ecosystem. Its output should be an RFC containing:

- independent implementations and lineage;
- shared semantics;
- explicit variation points;
- behavior deliberately excluded;
- overlap with existing facilities;
- coverage of each implementation;
- open design questions;
- tests and proposed maturity level.

The system can generate an experimental implementation and rewrite the cluster on a branch so humans can compare call
sites. It should not merge the abstraction itself.

Schema proposals can similarly emerge from recurring workarounds: repeated structures hidden in `extra`, parallel
auxiliary gestalts, common relationship conventions or repeated rejected fields. Recurrence identifies a question; it
does not decide whether the concept belongs on an item, an activity, an event or somewhere else. Ontology remains an
expert decision.

Rejected abstractions are durable knowledge. Record why a proposal hid meaningful distinctions so later agents do not
continually rediscover the same attractive mistake.

## Ecosystem knowledge graph

The observatory can maintain derived relationships such as:

```text
view -> imports facility
view -> queries/writes gestalt
view -> implements motif
view -> remixed from view
view -> reviewed by expert
view -> tested by fixture
view -> associated with evidence

facility -> provides behavior
facility -> replaces pattern
facility -> requires capability
facility -> demonstrated by example
facility -> evolved from candidate cluster
facility -> supersedes facility
```

This graph filters and explains retrieval; embeddings rank fuzzier matches within it. It is an index over source and
published metadata, not a new source of truth.

## Cost control

Most observation should not consume model tokens:

```text
on every change:
  AST extraction, dependency graph, schemas, capabilities, fingerprints and fixture traces

periodically:
  clone/motif clustering, embedding updates and changed-cluster detection

only for promising changed clusters:
  local-model explanation and variation matrix

only after evidence thresholds:
  stronger-model RFC and experimental implementation
```

Cache model work by reviewer/policy/model/source/context hashes. Preserve concise findings and decisions; raw local
traces need not sync or enter pull requests.

## Prior art and design stance

The architecture combines established ideas:

- Aider-style compact repository maps;
- Sourcegraph-style symbol and code-graph retrieval;
- Storybook-style generated component documentation;
- Backstage-style structured catalogs;
- ArchUnit and CodeQL-style executable conformance rules;
- Semgrep-style findings with project-specific remediation context;
- OpenRewrite-style tested transformation recipes;
- localization, repair and validation pipelines such as Agentless and AutoCodeRover;
- checker-derived, context-augmented repair as explored by DesignFix;
- branch and pull-request delivery used by current coding agents.

The distinctive opportunity is a vertical integration that understands Gestalts schemas, capabilities, learning
evidence, fixtures, user-space drafts and source plugins together.

## Suggested staging

### Stage 1: make current authoring cheaper

1. Generate a catalog from exports, schemas, types and existing usages.
2. Curate intent and canonical examples for the highest-value facilities.
3. Add schema, manifest-usage and structured patch-check tools.
4. Add a few high-confidence policy detectors.
5. Benchmark local models on focused repairs and common view requests.

### Stage 2: support local generation and review

1. Introduce internal view plans and a few optional archetype scaffolds.
2. Add named fixtures and layout/host-call observations.
3. Add local-provider routing, caching and explicit escalation.
4. Expose the tools through a JSON CLI and optional MCP adapter.
5. Deliver verified changes through the source-promotion workflow.

### Stage 3: begin observing the ecosystem

1. Store derived structural records and remix provenance.
2. Add optional intent and expert-rationale metadata.
3. Show similar views and relevant facilities without enforcing convergence.
4. Record accepted and rejected suggestions.
5. Introduce a registry with observed, experimental and stable pattern states.

### Stage 4: operate the foundry

1. Cluster independent implementations and behavioral motifs.
2. Produce variation matrices and candidate reports.
3. Generate reviewed experimental helpers or recipes on branches.
4. Gather voluntary adoption and expert evidence.
5. Stabilize, split or retire facilities through ordinary source review.

The governing principle is: frequency says where to investigate. Independent convergence, expert rationale,
successful adaptation, behavioral preservation and credible learning evidence say whether a real abstraction has been
found.
