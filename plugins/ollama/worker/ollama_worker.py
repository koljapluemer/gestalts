"""The `ollama@1` service: local language models through an Ollama server on this computer.

The server is `OLLAMA_HOST` (often a bare `host:port`), else 127.0.0.1:11434. Each caller names the model it was
tuned with; this service only passes requests on.

- `GET /models` → 200 `{models: [name]}`
- `POST /chat` `{model, system, user, schema?}` → 200 `{content}`. `schema` asks for JSON of that shape, but not every
  model keeps to it: callers parse the reply leniently.
- `POST /pull` `{model}` starts downloading the model in the background, unless that's under way; → 202 `{pull}`
- `GET /pull?model=<name>` → 200 `{pull}`: this worker's download of the model, `{status, completed, total, error}`
  (`status` "success" when done, `error` set when it failed), or null
- errors: 503 `{error}` without the server, 404 `{error, missing_model}` when it lacks the model, 400 for a bad request.
"""

import json
import os
import threading
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit

from gestalts_plugin import Worker, run_worker

# Keeps the model loaded between calls, so only the first one waits for it to load.
KEEP_ALIVE = "30m"
# Below the node's service timeout, so a slow reply is this service's error, not a 504.
CHAT_TIMEOUT = 170


class Unavailable(Exception):
    pass


class ModelMissing(Unavailable):
    """The server is up but doesn't have the model; `/pull` gets it."""


def server_url() -> str:
    u = (os.environ.get("OLLAMA_HOST") or "127.0.0.1:11434").strip().rstrip("/")
    return u if "://" in u else f"http://{u}"


def _request(path: str, body: dict | None) -> urllib.request.Request:
    return urllib.request.Request(
        server_url() + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )


def _server_error(e: urllib.error.HTTPError) -> str:
    """Ollama's own message, e.g. a missing model, rather than just the status."""
    try:
        return f"{e.code}: {json.loads(e.read())['error']}"
    except (OSError, ValueError, KeyError, TypeError):
        return str(e)


def _call(path: str, body: dict | None, timeout: float) -> dict:
    try:
        with urllib.request.urlopen(_request(path, body), timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise (ModelMissing if e.code == 404 else Unavailable)(_server_error(e)) from e
    except (OSError, ValueError) as e:
        raise Unavailable(str(e)) from e


def models() -> list[str]:
    try:
        return sorted(m["name"] for m in _call("/api/tags", None, 2)["models"])
    except (KeyError, TypeError) as e:
        raise Unavailable(f"unexpected reply: {e}") from e


def chat(model: str, system: str, user: str, schema: dict | None) -> str:
    res = _call("/api/chat", {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        **({"format": schema} if schema else {}),
        "stream": False,
        "think": False,  # a thinking model's reasoning takes minutes on a laptop
        "keep_alive": KEEP_ALIVE,
    }, timeout=CHAT_TIMEOUT)
    try:
        return res["message"]["content"]
    except (KeyError, TypeError) as e:
        raise Unavailable(f"unexpected reply: {e}") from e


_pulls: dict[str, dict] = {}
_pulls_lock = threading.Lock()


def pull_status(model: str) -> dict | None:
    with _pulls_lock:
        p = _pulls.get(model)
        return dict(p) if p else None


def pull(model: str) -> None:
    with _pulls_lock:
        cur = _pulls.get(model)
        if cur and not cur["error"] and cur["status"] != "success":
            return
        _pulls[model] = {"status": "starting", "completed": 0, "total": 0, "error": None}
    threading.Thread(target=_pull, args=(model,), daemon=True).start()


def _pull(model: str) -> None:
    def update(**kw):
        with _pulls_lock:
            _pulls[model].update(kw)

    try:
        with urllib.request.urlopen(_request("/api/pull", {"model": model, "stream": True}), timeout=60) as r:
            for line in r:  # one JSON object per progress step
                msg = json.loads(line)
                if msg.get("error"):
                    return update(error=msg["error"])
                update(status=msg.get("status", ""), completed=msg.get("completed", 0), total=msg.get("total", 0))
    except urllib.error.HTTPError as e:
        update(error=_server_error(e))
    except (OSError, ValueError) as e:
        update(error=str(e))


def _json(status: int, value) -> tuple[int, str, bytes]:
    return status, "application/json", json.dumps(value).encode()


def _model(value) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def service(method: str, path: str, body: bytes) -> tuple[int, str, bytes]:
    url = urlsplit(path)
    route = (method, url.path.rstrip("/"))
    try:
        request = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return _json(400, {"error": "body is not JSON"})
    if not isinstance(request, dict):
        return _json(400, {"error": "body is not a JSON object"})
    try:
        if route == ("GET", "/models"):
            return _json(200, {"models": models()})
        if route == ("POST", "/chat"):
            model, system, user = _model(request.get("model")), request.get("system", ""), request.get("user")
            schema = request.get("schema")
            if not model or not isinstance(system, str) or not isinstance(user, str) or not isinstance(schema, (dict, type(None))):
                return _json(400, {"error": "expected {model, system?, user, schema?}"})
            try:
                return _json(200, {"content": chat(model, system, user, schema)})
            except ModelMissing as error:
                return _json(404, {"error": str(error), "missing_model": model})
        if route == ("POST", "/pull"):
            model = _model(request.get("model"))
            if not model:
                return _json(400, {"error": "expected {model}"})
            pull(model)
            return _json(202, {"pull": pull_status(model)})
        if route == ("GET", "/pull"):
            model = _model((parse_qs(url.query).get("model") or [None])[0])
            if not model:
                return _json(400, {"error": "expected ?model=<name>"})
            return _json(200, {"pull": pull_status(model)})
    except Unavailable as error:
        return _json(503, {"error": str(error)})
    return _json(404, {"error": f"no {method} {url.path}"})


if __name__ == "__main__":
    worker = Worker(lambda request: {"note": "ollama only answers its service"})
    worker.service("ollama@1", service)
    run_worker(worker)
