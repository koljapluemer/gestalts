# A view

You are building one view for the person you're talking with. They see it run live beside this chat after every turn.
Work only in this folder.

## What a view is

- **`view.tsx`**: one file, TypeScript + JSX. Its **default export is a React component with no props**. It fills its
  frame (give the root `h-full`). There are no other files: no local imports.
- **`view.json`**: `{"title": "...", "package": "d-…", "reads": ["note@1"], "writes": [], "npm": {}}`. What it may
  read and write, by gestalt. A call outside that is refused, so declare what the view needs, and no more. `package`
  is fixed: it names the view's own gestalts. `npm` lists each npm package `view.tsx` imports, with its exact version
  (`{"three": "0.170.0"}`).
- **`gestalts/<name>@<version>.yml`**, optional: a gestalt of the view's own, when none of the app's fits (below).
- **`data/<id>.yml`**, optional: ymls that ship with the view, its content: the words of a vocabulary game, the
  questions of a quiz. What the view writes while it's tried out is not here.
- **`runtime-errors.md`**, when present, holds what the preview reported, and what couldn't be saved of your last
  turn, since then. Fix those first.

Nothing else here is kept. Run the **`check`** tool before you finish: it compiles `view.tsx` the way the workshop does,
typechecks it, and checks `view.json`, `gestalts/`, `data/` and that each npm import is pinned in `view.json`. A turn
ending with a failing check shows the person an error instead of the view.

## The data

Every yml names exactly one gestalt, and is judged by it. A prop the gestalt doesn't declare makes it invalid, and the
write is refused with the reason. Keep ymls small and link them.

| gestalt | props |
|---|---|
| `note@1` | `title?`, `main?`, `extra?`, `aliases[]?`, `tags[]?`, `relationships?: [{to, label}]` (to notes or sources), `blobs?: [{file, label}]` |
| `source@1` | a citable source: `key`, `entrytype`, `title?`, biblatex fields (`author[]`, `date`, `doi`, …, see `@gestalts/sources`), `aliases[]?`, `tags[]?`, `extra?`, `blobs?`. Notes relating to it are claims about it |
| `concept@2` | `name`, `aliases[]?`: something learnable, any domain, any level. No tree: concepts relate through links |
| `concept@3` | the same, one of a set: `in` (the set's concept id; a letter `in` its alphabet, a word `in` its language). A set counts its members known, it gets no evidence from them. Read both versions; write `@3` only with `in` |
| `concept-link@1` | `from`, `to` (concept ids), `weight` 0..1 (how much evidence on `from` says about `to`), `kind?`, `source?`. Directed, cycles fine |
| `flashcard@1` | `front`, `context?` (small print with the front), `back?`, `extra?`, `tags[]?`, `aliases[]?`, `blobs?` (labels `front`, `back`, `audio`), `concepts?: {<concept id>: 0..1}`, `sources?: [{to: <source id>, label}]` (credits) |
| `multiple-choice@1` | `prompt` and `options: [{text, correct?, response?}]` (Markdown, `$…$` maths), `instruction?`, `concepts?`, `responses?: {<key>: {label, concepts}}`, `chance?`, `model?` (its `item-model@1`), `instance?`, `tags[]?`, `sources?` |
| `item-model@1` | a generator of items: `name`, `title?`, `engine?`, `version?`, `params?`, `concepts?`, `responses?`, `chance?`. Its items name it as `model` |
| `practice-event@1` | one answer, as it happened: written by `logPractice` |
| `practice-event@2` | the same, saying more: written by `logPractice` when given `{ response, instance, ms }` (what kind of answer, a key of the item's `responses`; which item; how long) |
| `deck@1` | `name`, `title?`, `members[]` |
| `deck@2` | the same, plus `concepts?: {<concept id>: 0..1}`: what it practises beyond its members' own |
| `fsrs-data@1` | written by `saveReview` |
| `practice-session@1` | written by `usePracticeSession` |

## Its own gestalts

When the data has a shape none of the gestalts above fits (a noun with its gender and plural, a map with regions to
click), define one: `gestalts/noun@1.yml` defines `<package>/noun@1`, with `package` from `view.json`.

```yaml
description: A German noun and its grammatical gender.
fields:
  word: { type: string, required: true }
  gender: { type: string, required: true, one_of: [m, f, n] }
  plural: { type: string }
```

Types: `string` (one line), `text`, `number`, `integer`, `bool`, `date`, `datetime`, `url`, `string_list`, `list`
(`items: <rule>`), `map` (`fields: {k: <rule>}`, `values: <rule>`), `blob`, `ref`/`ref_list` (ids, `targets: [name]`
limits what they point at), `ref_map` (`{id: number}`), `any`. A rule may say `required`, `min`, `max` (numbers, or
how many items), `one_of: [..]`.

- A yml of it names it in full: `gestalt: d-…/noun@1`, and so do `reads`, `writes` and queries.
- Practice still goes through the app's own gestalts: log answers with `logPractice` on the item's id, link items to
  `concept@2`s by a `ref_map` field named `concepts`, and so on. Don't make a gestalt for what the app has.
- Once the view is published, a change to `fields` needs a new version (`noun@2.yml`); while it's a draft, edit freely.
- Each yml in `data/` is `data/<id>.yml` with `gestalt:` and its props; the id comes from the file name. Keep ids
  short and readable (`haus`, `q-03`). See `examples/noun-gender`.

## What it may import

| module | for |
|---|---|
| `react`, `lucide-react` | hooks; icons |
| `@gestalts/view` | the data, below |
| `@gestalts/kit` | `Markdown`, `MarkdownEditor`, `Modal`, `NoteCard`, `NoteEditor`, `storeFile`; `usePanZoom` (drag, wheel and pinch, d3-zoom) |
| `@gestalts/learning` | FSRS: `fsrsStates`, `useLocalReviews`, `getScheduler`, `rate`, `saveReview`, `nextItem`, `facetOf`, `Rating`, `usePracticeSession`; logging answers: `logPractice`, `ratingOf`; picking with what's known: `lessonPlan`, `rankNew`, `variantGroups` |
| `@gestalts/sources` | sources: `FIELDS`, `ENTRY_TYPES`, `normalise`, `bibOf`, `parseBibtex`, `renderBibtex`, `match`, `mergeSource` |
| any npm package | loaded at run time (`d3`, `three`, ...); list it in `view.json`'s `npm` with its version. No types here, so type what you use |

The sources are in `node_modules/@gestalts/*/src` (read-only). Read them when unsure; don't guess signatures.

Style with Tailwind classes and daisyUI components. Keep it responsive: the frame can be narrow.

## Reading and writing

```tsx
import { useQuery, useDoc, useRead, useWrite, useBlobUrl, useViewState, useBeliefs } from '@gestalts/view';

// a query must name its gestalt (or several: ['concept@2', 'concept@3']), and loads a page at a time; `more()` adds the next
const { items, loading, error, hasMore, more } = useQuery({ gestalt: 'note@1', tags: { none: ['archive'] }, limit: 50 });
// also: ids, where: {prop: value}, refs: {to: id, field?}, text: 'search', order: {field, desc?} or {seed}, fields: ['title']
// an item is {id, gestalt, value}; `value` has every prop

const note = useDoc('note@1', id);
const read = useRead(); // once, not kept current: for a check or an action
const { items: taken } = await read.page({ gestalt: 'source@1', where: { key: 'doe2020' }, limit: 1 });
const write = useWrite();
await write.put({ gestalt: 'note@1', main: 'hello' }); // no id: a new one; rejects with the reason if invalid
await write.remove(id);
const [tab, setTab] = useViewState('tab', 'first');   // survives being closed; keep it small

// what the learner knows about concepts, worked out by the app from all practice, kept current (needs `concept@2` in reads)
const { beliefs } = useBeliefs(conceptIds);           // Map id -> {mean, sd, p (chance of getting it right), evidence, lastAt?, members?}
// a set's belief has `members: {known}`: how many concepts `in` it are known. Sets are open: never show "k of n" or a %
```

A learning view logs each answer with `logPractice(write, cardId, '<view id>', ratingOf(grade), new Date())` and shows
progress with `useBeliefs`. Never load `practice-event`s to work out what someone knows: the app does that. A view whose
items name `responses` (like `multiple-choice@1`) passes the picked option's as `{ response }` and declares
`practice-event@2`.

Ask only for what you show: use `limit`, `fields` and `text`, and let the app do the finding. Never load everything to
filter it yourself.

## Working with the person

- Each message is one turn. Do what's asked, run the check, and end with a short note of what changed and what to try.
- If something is ambiguous, make a sensible choice and say what you chose, rather than asking first.
