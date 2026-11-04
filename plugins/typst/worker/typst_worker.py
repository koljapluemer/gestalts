"""The `typst@1` service: compiles a Typst document sent by the app.

`POST /compile` with `{source, assets?: {path: blob}, bib?: str, format?: "svg" | "pdf"}`. The document is compiled
in a fresh folder: `main.typ` is the source, each asset is the blob placed at its path (e.g. `/images/a.webp`), and
`bib` is `/sources.bib`. System fonts are ignored, so a document looks the same on every machine.

- `svg`: 200 `{pages: [svg], warnings: [str]}`
- `pdf`: 200 with the PDF
- errors: 422 `{diagnostics: str, missing: [path]}`; `missing` lists assets the connector doesn't have (yet), e.g.
  an image added in the app that hasn't synced to the folder.
"""

import json
import re
import tempfile
from pathlib import Path, PurePosixPath

import typst
from gestalts_plugin import ConnectorClient, Worker, run_worker

client = ConnectorClient()


def _json(status: int, value) -> tuple[int, str, bytes]:
    return status, "application/json", json.dumps(value).encode()


def _place(root: Path, path: str) -> Path | None:
    """Where an asset's path lands in the compile folder; None for a path that would leave it."""
    p = PurePosixPath("/" + path.lstrip("/"))
    if any(part in ("..", "") for part in p.parts[1:]) or p.name in ("main.typ", "sources.bib"):
        return None
    return root.joinpath(*p.parts[1:])


def _tidy(message: str) -> str:
    """Diagnostics name the document `main.typ`, not a path into the temporary folder."""
    return re.sub(r"\S*?/(main\.typ|sources\.bib)", r"\1", message)


def compile_document(request: dict) -> tuple[int, str, bytes]:
    source = request.get("source")
    fmt = request.get("format", "svg")
    if not isinstance(source, str) or fmt not in ("svg", "pdf"):
        return _json(400, {"error": "expected {source: str, format: svg|pdf}"})
    with tempfile.TemporaryDirectory(prefix="gestalts-typst-") as tmp:
        root = Path(tmp)
        (root / "main.typ").write_text(source, encoding="utf-8")
        missing = []
        for path, blob in (request.get("assets") or {}).items():
            target = _place(root, path)
            data = client.read_blob(blob) if target is not None else None
            if data is None:
                missing.append(path)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if isinstance(request.get("bib"), str):
            (root / "sources.bib").write_text(request["bib"], encoding="utf-8")
        try:
            out, warnings = typst.compile_with_warnings(str(root / "main.typ"), root=str(root), format=fmt, ignore_system_fonts=True)
        except typst.TypstError as error:
            return _json(422, {"diagnostics": _tidy(error.diagnostic or error.message), "missing": missing})
    notes = [_tidy(getattr(w, "diagnostic", None) or str(w)) for w in warnings or []]
    if fmt == "pdf":
        return 200, "application/pdf", out
    pages = out if isinstance(out, list) else [out]
    return _json(200, {"pages": [p.decode("utf-8") for p in pages], "warnings": notes, "missing": missing})


def service(method: str, path: str, body: bytes) -> tuple[int, str, bytes]:
    if (method, path) != ("POST", "/compile"):
        return _json(404, {"error": f"no {method} {path}"})
    try:
        request = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return _json(400, {"error": "body is not JSON"})
    return compile_document(request)


worker = Worker(lambda request: {"note": "typst only answers its service"})
worker.service("typst@1", service)
run_worker(worker)
