# Plugins

A plugin is a folder:

```
my-plugin/
  plugin.yml      # id, version, title; optional description, reads, writes, tags, requires
  view.tsx        # one React file; its default export is the view
  gestalts/<name>/v1.yml   # optional: gestalts it owns
  decks/<id>/              # optional: ymls it ships, one `deck@1` among them
  backend.py               # optional; see Backends
```

```yaml
id: quick-note
version: 1.0.0
title: Quick note
reads: [note@1]
writes: [note@1]
```

`reads` and `writes` are enforced outside the view. An app lists its plugins by path in `distribution.yml`, as `core`
(always there) or `plugins` (installable).

A view may also ask for:

- `network: [www.example.com]`: HTTP to exactly these hosts (https, default port) with `useNet()`, through the node,
  so CORS doesn't apply. No cookies or credentials pass, and redirects must stay on the list.
- `llm: true`: completions with `useLlm()`, from the providers the user set up in the app (tried in their order,
  skipping rate-limited ones). Keys stay in the node.
- `permissions: [...]`: what its frame may do beyond the strict sandbox. Each is granted only by the app, per view, in
  `distribution.yml`, which may grant less than asked:

  ```yaml
  grants:
    transparent-input: [same-origin]
    phrasebook: [same-origin, microphone]
  ```

  - `same-origin`: the frame runs in the app's origin, so frames it embeds (a video player) work. Granted views run as
    part of the app, with its data and storage, so only code you'd ship in the app belongs there, and the build refuses
    one that imports npm packages (they'd load from esm.sh at run time).
  - `microphone`: it may record (the browser still asks the user). Needs `same-origin` too: a sandboxed frame isn't a
    secure context, so it can't record. `useCapabilities().microphone` says whether it was granted.

  Every other view keeps the strict sandbox, even if it asks. The build refuses a grant the view didn't ask for.

`network` and `llm` work where a node is: a page using gestalts-node, directly or by syncing with it. `useCapabilities()` says whether
they do, so a view can offer less instead of failing.

A view imports `react`, `lucide-react`, `@gestalts/view`, `@gestalts/kit`, `@gestalts/learning`, `@gestalts/sources`,
and any npm package.
There are no local imports. `plugins/note-queue/view.tsx` is a short real one.

A learning view logs each answer as a `practice-event` (`logPractice` in `@gestalts/learning`) and shows what the
learner knows with `useBeliefs(conceptIds)`: beliefs the app works out from all practice, live, for just those
concepts. It needs `concept@2` in `reads`, not the events ([data-format.md](data-format.md)).

## Where a view is

A view's params are where it is, like a URL: what it shows that someone else could send it to. `useParams()` gives them
and a setter; the app keeps them with the tab, so a reload comes back there. What isn't a place (a search box, a
draft) belongs in `useViewState`.

`useHost().openView(view, params)` shows another view: its most recently used tab, moved to `params`, else a new tab.
It answers whether the app could, since an app may not have that view (a preview has none). Notes takes `note` (an id)
and `edit=1`, so Quick note's Save and Edit is:

```tsx
await openView('note-crud', { note: id, edit: '1' });
```

Params are strings. A view that takes them says which in its doc comment.

## Backends

`backend.py` is one file with PEP 723 inline metadata; the node gives it an environment through uv.

```python
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
from gestalts_backend import Backend

backend = Backend()

@backend.route("/hello")
def hello(body):
    return {"hello": body["name"]}

backend.run()
```

A view calls it with `useService()`. Backends run only where there's a node: not on a phone, and not in a static site.
With `requires: [backend]` in `plugin.yml` the view needs it, and is hidden where it can't run. Without, the backend is
optional: the view runs everywhere, and `useCapabilities().backend` says whether its backend is up, so it can offer
what needs it only then (`plugins/source-manager` writes its .bib that way). `backend.data` reads and writes ymls within the plugin's `reads` and `writes`.
That limit is on the node's API only: a backend is ordinary local code.
