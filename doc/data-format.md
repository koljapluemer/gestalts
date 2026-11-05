# Data format

```
my-gestalt-data/
  notes/<key>.yml
  blobs/<name>
  index.json        # only when published as a static site: {"notes": [keys], "blobs": [names]}
```

A note is any YAML. Conventions, all optional:

| field | meaning |
|---|---|
| `id` | global uuid, normally also the file name |
| `title` | one line |
| `main` | the content, usually multi-line |
| `extra` | more Markdown, shown below `main`; references in it count as in `main` |
| `tasks` | a note about the note, e.g. what's left to do with it |
| `aliases` | other names, list of strings |
| `tags` | contexts the note is (not) used in; letters, digits, dashes |
| `relationships` | list of `<uuid>` or `{to: <uuid>, label: <label>}`; label `inline` for each `[[uuid]]` in `main`, `extra` or a card, kept in step by the app |
| `blobs` | list of `<file>` or `{file: <file>, label: <label>}`; images and videos attached to the note are labelled `image` / `video`; every `![[file]]` embedded in the text is listed |
| `upstream` | where a copied note came from, see [Published decks](#published-decks) |
| `canvas`, `template`, `cards` | the note's own canvas, template and flashcards ([gestalts.md](gestalts.md#folded-parts)) |
| `folded` | on a retired note whose content moved into another note: `{into, hash}` ([gestalts.md](gestalts.md#folded-parts)) |
| `deleted` | a **tombstone**: a note that is only `{id, deleted: <datetime>}` was deleted. It's kept forever, so the delete syncs; queries and the search skip it, and writing the note again brings it back |

How the core copes with missing or broken pieces:
- A note without an `id` is addressed by its key, the file name without `.yml`.
- A file name that isn't a uuid is fine.
- Text that doesn't parse is kept as it is and reported as an error, so the universal editor can still fix it.
- An empty file counts as an empty map.

## Published decks

A deck shipped read-only (one of a plugin's `decks`) follows a few more rules, so that copies in user space can
follow it:
- **Blobs are content-addressed**: `<first 16 hex digits of sha256>.<ext>`. A replaced image gets a new name, which changes the note that uses it.
- **Notes are never deleted, they're retired**: tag them `retired` (publishing rejects tombstones). Perspectives skip retired notes, and copies pick the tag up like any other change.
- **Note ids are the file names**, since relationships are resolved to keys in the deck.
- **Keys say what a note is**, so the same thing has the same key in every deck: a country is
  `stableId("country", <ISO alpha-3>)`, a group of them `stableId("country-group", <id>)`. Where several mounted decks
  hold a key, it reads as the merge of their texts by the gestalts' rules, without a base (tags and relationships
  unite); a value they disagree on is reported, and the merge's canonical winner kept. Decks holding the same note
  should agree on everything but what they leave out (the Africa deck keeps only African look-alikes).
- Deck notes have no `upstream` field. User-space copies get one, appended as the last lines:

  ```yaml
  upstream:
    sources: [learn-world-map/africa, learn-world-map/whole-world]   # the decks merged into it, <plugin>/<deck>
    hash: <sha256 of the merged text as copied>
  ```

  A copy is untouched while the text before the trailer still has that hash.

To publish after editing notes or overwriting blob files, run `mise run publish-data <folder>` (e.g.
`plugins/<id>/decks/<deck>`; gestalt-plugins has its own task) and commit the result. It:
1. renames blobs to their content hash and rewrites the notes that use them
2. deletes blobs no note uses
3. writes `index.json`
4. lints

Running it again changes nothing.

Keys and blob names must not contain `/`, `\` or control characters, and must not start with `.`.
