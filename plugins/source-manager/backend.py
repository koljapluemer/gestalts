# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Writes the .bib the view renders to a path on this machine. Optional: without it, the view does everything else.

- `POST /export` `{path, text}` -> `{path, written}`: `path` absolute (or from `~`) and ending in `.bib`. An existing
  file is replaced only if it starts with the same first line as `text` (the generated header), so a .bib written by
  hand is never overwritten; one already holding `text` is left alone (`written: false`).
"""

import os
import tempfile
from pathlib import Path

from gestalts_backend import Backend

backend = Backend()


class Refused(Exception):
    pass


def export(path: str, text: str) -> dict:
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise Refused(f"{path}: give an absolute path (or one starting with ~)")
    if target.suffix != ".bib":
        raise Refused(f"{path}: the file should end in .bib")
    header = text.split("\n", 1)[0]
    if target.exists():
        current = target.read_text(encoding="utf-8", errors="replace")
        if current == text:
            return {"path": str(target), "written": False}
        if current.split("\n", 1)[0] != header:
            raise Refused(f"{target} wasn't written by this export; not overwriting it")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return {"path": str(target), "written": True}


@backend.route("/export")
def handle_export(body):
    if not isinstance(body, dict) or not isinstance(body.get("path"), str) or not isinstance(body.get("text"), str):
        return 400, "text/plain", b"expected {path, text}"
    try:
        return export(body["path"], body["text"])
    except Refused as error:
        return 409, "text/plain", str(error).encode()


if __name__ == "__main__":
    backend.run()
