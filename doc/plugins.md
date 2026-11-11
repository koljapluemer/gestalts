# Plugins

A plugin is a folder:

```
my-plugin/
  plugin.yml      # id, version, title; optional description, reads, writes, tags, requires
  view.tsx        # one React file; its default export is the view
  gestalts/<name>/v1.yml   # optional: gestalts it owns
  decks/<id>/              # optional: ymls it ships, one `deck@1` among them
  backend.py               # optional, with `requires: [backend]`
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
- `frame: same-origin`: its frame runs in the app's origin, so frames it embeds (a video player) work. It's granted
  only by the app, in `distribution.yml`:

  ```yaml
  same_origin: [transparent-input]
  ```

  Granted views run as part of the app, with its data and storage, so only code you'd ship in the app belongs there,
  and the build refuses one that imports npm packages (they'd load from esm.sh at run time). Every other view keeps the
  strict sandbox, even if it asks.

`network` and `llm` work where a node is: the desktop app, or a page connected to it. `useCapabilities()` says whether
they do, so a view can offer less instead of failing.

A view imports `react`, `lucide-react`, `@gestalts/view`, `@gestalts/kit`, `@gestalts/learning`, and any npm package.
There are no local imports. `plugins/note-queue/view.tsx` is a short real one.

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

A view calls it with `useService()`. Backends run only where there's a node: not on a phone, and not in a static site. A
view that requires one is hidden there. `backend.data` reads and writes ymls within the plugin's `reads` and `writes`.
That limit is on the node's API only: a backend is ordinary local code.
