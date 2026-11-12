# A view

You are building one view for the person you're talking with. They see it run live beside this chat after every turn.
Work only in this folder.

## What a view is

- **`view.tsx`**: one file, TypeScript + JSX. Its **default export is a React component with no props**. It fills its
  frame (give the root `h-full`). There are no other files: no local imports.
- **`view.json`**: `{"title": "...", "reads": ["note@1"], "writes": []}`. What it may read and write, by gestalt. A
  call outside that is refused, so declare what the view needs, and no more.
- **`runtime-errors.md`**, when present, holds what the preview reported since the last turn. Fix those first.

Nothing else here is kept. Run **`node check.ts`** before you finish: it compiles `view.tsx` the way the workshop does,
typechecks it, and checks `view.json`. A turn ending with a failing check shows the person an error instead of the view.

## The data

Every yml names exactly one gestalt, and is judged by it. A prop the gestalt doesn't declare makes it invalid, and the
write is refused with the reason. Keep ymls small and link them.

| gestalt | props |
|---|---|
| `note@1` | `title?`, `main?`, `extra?`, `aliases[]?`, `tags[]?`, `relationships?: [{to, label}]` (to notes or sources), `blobs?: [{file, label}]` |
| `source@1` | a citable source: `key`, `entrytype`, `title?`, biblatex fields (`author[]`, `date`, `doi`, …, see `@gestalts/sources`), `aliases[]?`, `tags[]?`, `extra?`, `blobs?`. Notes relating to it are claims about it |
| `concept@2` | `name`, `aliases[]?`: something learnable, any domain, any level. No tree: concepts relate through links |
| `concept-link@1` | `from`, `to` (concept ids), `weight` 0..1 (how much evidence on `from` says about `to`), `kind?`, `source?`. Directed, cycles fine |
| `flashcard@1` | `front`, `context?` (small print with the front), `back?`, `extra?`, `tags[]?`, `aliases[]?`, `blobs?` (labels `front`, `back`, `audio`), `concepts?: {<concept id>: 0..1}`, `sources?: [{to: <source id>, label}]` (credits) |
| `practice-event@1` | one answer, as it happened: written by `logPractice` |
| `deck@1` | `name`, `title?`, `members[]` |
| `fsrs-data@1` | written by `saveReview` |
| `practice-session@1` | written by `usePracticeSession` |

## What it may import

| module | for |
|---|---|
| `react`, `lucide-react` | hooks; icons |
| `@gestalts/view` | the data, below |
| `@gestalts/kit` | `Markdown`, `MarkdownEditor`, `Modal`, `NoteCard`, `NoteEditor`, `storeFile` |
| `@gestalts/learning` | FSRS: `fsrsStates`, `useLocalReviews`, `getScheduler`, `rate`, `saveReview`, `nextItem`, `facetOf`, `Rating`, `usePracticeSession`; logging answers: `logPractice`, `ratingOf`; picking with what's known: `lessonPlan`, `rankNew`, `variantGroups` |
| `@gestalts/sources` | sources: `FIELDS`, `ENTRY_TYPES`, `normalise`, `bibOf`, `parseBibtex`, `renderBibtex`, `match`, `mergeSource` |
| any npm package | loaded at run time from esm.sh (`d3`, `three`, ...). Needs the network. No types here, so type what you use |

The sources are in `node_modules/@gestalts/*/src`. Read them when unsure; don't guess signatures.

Style with Tailwind classes and daisyUI components. Keep it responsive: the frame can be narrow.

## Reading and writing

```tsx
import { useQuery, useDoc, useRead, useWrite, useBlobUrl, useViewState, useBeliefs } from '@gestalts/view';

// a query must name one gestalt, and loads a page at a time; `more()` adds the next
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
const { beliefs } = useBeliefs(conceptIds);           // Map id -> {mean, sd, p (chance of getting it right), evidence, lastAt?}
```

A learning view logs each answer with `logPractice(write, cardId, '<view id>', ratingOf(grade), new Date())` and shows
progress with `useBeliefs`. Never load `practice-event@1`s to work out what someone knows: the app does that.

Ask only for what you show: use `limit`, `fields` and `text`, and let the app do the finding. Never load everything to
filter it yourself.

## Working with the person

- Each message is one turn. Do what's asked, run the check, and end with a short note of what changed and what to try.
- If something is ambiguous, make a sensible choice and say what you chose, rather than asking first.
