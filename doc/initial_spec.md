# gestalts

## Core Idea

The concept of this app-meta-system is to provide a system to un-silo a vast range of personal data that can be represented as plain-text, allowing interaction with these data with flexible, customizable view interfaces.

Long-term use cases include such flows such as:

1. Practicing Spanish on DuoLingo. Browser plugin extracts vocabulary from rendered HTML and saves it to the data storage
2. Another web app (made here) loads the same data storage, allowing to practice the extracted vocabulary in a custom spaced repetition flashcard view
3. The same web app has another view that renders data as a graph view (using again the same data source), allowing the user to manage semantic relationships (in the vocabulary context, perhaps opposites or related words or example sentences)
4. Such added example sentences can be practiced in an automatic cloze-practice view, yet again using the same data
5. The user may also open the file of a given vocabulary word and e.g. attach a deadline when this word has to be remembered. This deadline then shows up in a calendar view in perhaps yet another frontend.
6. At the same time, the user may two-way sync all their notes of a specific kind to Obsidian.md

The goal is not to build an unfathomable spaghetti heap to hack together this specific workflow, but to find an abstraction that makes this level of portability+convenient data acesss work. Thus:

## Data Architecture

The prototypical data storage is a folder on the user's device, with two subfolders:
```
my-gestalt-data/
|--notes/
|--blobs/
```

We represent everything that we can represent in plaintext in plaintext yml, and we call it a `note`.
Everything else (images, videos, PDFs, ...) is a `blob`.

We generally try to find a small unit that sensibly yields one note, e.g. one vocabulary word, one appointment, one to-do, one learning top, one research question = one note.
Each of these files is saved flat in the `notes/` folder as `.yml`.

We accept any kind of yaml, and basically any kind of blob.
We do have a few conventions (likely more to come) to make the system in itself work:

- each note should have an `id` with a global uuid, also used as filename. We do however try to be robust if either is not given.
- most notes will have `main` prop that is a multi-line string, defining "the content"
- a lot of notes will have a single-line `title`
- some notes will have `aliases`, a string array of alternative ways to refer to this note
- `relationships` should allow storing uuids of other notes, using either a semantic label or no label
- `blobs` refer to blobs attached to the note, again either with or w/o a semantic label
- `tags` is a list of alphanumeric+dash strings, extremely important, used to specify in which contexts a notes will (not) be used

Again, a note doesn't *have* to have any of these. 

Crucially, we will then define `gestalts`, which are semantically meaningful schemas. A note may have multiple gestalts. For example:

- A note that has "flashcard" in `tags` and has a `front` and a `back` (multi- or single-line strings) may be considered to have a valid _flashcard_ gestalt.
- A note that has "appointment" in `tags` and a `date` prop with a valid data may be considered to have a valid _appointment_ gestalt.
- A note that has `url` set with a well-formed url may be considered to have a _link_ gestalt.

Note how it's easily possible for a note to have both a _link_ and an _appointment_, for example.

We will track the used gestalts in the source, using a schema + (likely a custom) linting format (to express stuff like _flashcard_ should have a `front` and a `back` and 0 or 1 `sr-data`)


Next, the source of truth does not have to be a folder on disk, it may for example be OPFS in a browser context instead. 
Which brings us to:

## Software Architecture

### Rust Core

A portable, slim core with an hexagonal architecture that can read/write notes and blobs.

### Desktop Connector

A slim Rust app that allows to set a folder on disk as source of truth and allows communication with e.g. browser static site frontends, browser plugins, and whatever else may be needed in the future

### Android Connector

The same but as an Android app.

### gestalts/

typing/scheming the gestalts used, as described above.
Use a simple versioning scheme so gestalts and perspectives can change without hard-to-understand compatibility issues.

### Perspectives

A `perspective` is a React Component that defines an arbitrarily bespoke/complex or simple interface to interact with note+blob data.
It should be self-contained, so that it for example can be embedded in multiple apps (example below).

To give an intuition on `perspective`, a perspective may be:

- A "CMS", allowing the user to manage and publish an SSG-powered blog based on "markdown files" saved within our yaml format 
- A widget with convenient date selector to quickly add `appointment` notes
- A web game to memorize countries on the world map, managing both the country geojson data and the per-user learning data as notes

As such, `perspective`s should also be built as an hexagon, using clearly-defined, standardized ports.
A `perspective` should define "a hashmap" (perhaps abstracted) of data it will interact with, e.g. "`events` is all notes with an appointment shape and a date not in the past, and `goals` is all notes with a "goal" entry in `tags`"

#### Component Framework

To speed up development, we will over time establish a little component framework for stuff that more than one `perspective` uses.
We will follow a layered architecture, where every layer is only allowed to import from below, not from neighbors or layers above.

- `primitives`: Our *actual* primitives are going to be tailwind+daisyUI+lucide-icon components. We will not reimplement stuff like "button" or "card". This lowest level thus may be stuff like a "MarkdownRenderer" (for example). Btw, the tailwind+daisy+lucide stack applies for everything, including the web apps described below.
- `components`: May import `primitives`. May be useful for stuff like a "NoteRenderer", which configurably renders e.g. parts of notes in a standardized way, e.g. title like this, main like that. It's only a component if it indeed imports at least one primitive.
- `widgets`: May import `components` and `primitives`. Useful for "meta-components" like e.g. a component that can toggle between viewing and editing a note, and thus imports (for example) a "NoteRenderer" and a "NoteEditor"
- `perspective`: The actual useful interact-with-my-data layer. May import all 3 below.
- `pane`: In real applications, we will often have need to combine perspectives, e.g. with a main `perspective` for the task and a generic search sidebar next to it. `pane` should only import perspectives and manage them visually (with CSS grid and breakpoints, and maybe stuff like sidebar toggles). The pane is also an event orchestrator for perspectives to talk to each other.

##### Stuff to build for demo prototype

Let's actually build some `perspective`s for an initial demo (and some fairly trivial `pane`s)

- Add a "search sidebar" perspective inspired by the global sidebar in the ../dsl repo.
- Add a "universal editor" perspective that allows the user to edit any note as raw (but syntax-highlighted yml). Sort of like Exploration tab in ../dsl.
- Add a pane combining the two, allowing the user to open notes in the universal editor via the sidebar.
- Add a perspective (and a pane just showing it) that replicates the ~/GITHUB/sam-learns-things/src/apps/ancient-greek-alphabet experience. Make up good gestalts to represent the learning data. Add a script in ~/SCRIPTS that one-time migrates required data from sam-learns to our format.

### Web Apps

Let's add two basic web apps to demonstrate portability.

Apps should be usable who have 0 interest in the larger system and do not have the desktop connector (e.g. just as a client-side learning app for fun),
yet connecting the desktop connector should be possible.

Add a 3-legged merge function for when the connector is running, keep it simple for now.

#### Gestalter

Our main app (vite+react) that regular users of the system will utilize.
It should have (for now) a toggle in the top that allows switching between all available panes

#### Demo

A proof-of-concept for a public facing app focussed on learning. 
It should allow people to practice Greek letters with the frame discussed above.
The pre-existing learning data should be in public/ folder, and the per-user learner data managed in OPFS.


## Philosophy

Try to keep speculative abstraction to a minimum.
For now, I need a personal use demo that works (or demonstrates to me why it cannot be made to work).
The stuff to build is mostly what's needed for the described demo prototype above.
Yet, try to avoid coding is in a corner later, when the app has multiple/many users, and many gestalts and frame.

## Misc

- Add justfile with just the actual convenient commands (not everything possible under the sun)
- Keep the `doc/` folder up-to-date with structured documentation. Keep the README.md very lean.