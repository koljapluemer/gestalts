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
