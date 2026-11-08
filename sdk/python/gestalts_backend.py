"""What a plugin's backend.py imports: one file, no dependencies, put on the path by the node.

    from gestalts_backend import Backend

    backend = Backend()

    @backend.route("/hello")
    def hello(body):
        return {"hello": body["name"]}

    backend.run()

A handler gets the request body (parsed if it's JSON, else bytes) and returns something JSON-serializable, or
`(status, content_type, bytes)`. `backend.data` reads and writes the ymls the plugin's `reads` and `writes` allow.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Data:
    """The node's API, as this plugin. Ymls are YAML text."""

    def __init__(self) -> None:
        self.base_url = os.environ["GESTALTS_NODE_URL"].rstrip("/")
        self.token = os.environ["GESTALTS_PLUGIN_TOKEN"]

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> bytes | None:
        request = urllib.request.Request(self.base_url + path, data=body, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if content_type:
            request.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise RuntimeError(f"node returned {error.code}: {error.read().decode(errors='replace')}") from error

    @staticmethod
    def _quote(name: str) -> str:
        return urllib.parse.quote(name, safe="")

    def read_yml(self, id: str) -> str | None:
        text = self._request("GET", "/ymls/" + self._quote(id))
        return None if text is None else text.decode()

    def write_yml(self, id: str, text: str) -> None:
        self._request("PUT", "/ymls/" + self._quote(id), text.encode(), "application/yaml")

    def delete_yml(self, id: str) -> None:
        self._request("DELETE", "/ymls/" + self._quote(id))

    def read_blob(self, name: str) -> bytes | None:
        return self._request("GET", "/blobs/" + self._quote(name))

    def write_blob(self, name: str, data: bytes) -> None:
        self._request("PUT", "/blobs/" + self._quote(name), data, "application/octet-stream")


class Backend:
    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Callable[[Any], Any]] = {}
        self.data = Data()

    def route(self, path: str, method: str = "POST") -> Callable[[Callable[[Any], Any]], Callable[[Any], Any]]:
        def register(handler: Callable[[Any], Any]) -> Callable[[Any], Any]:
            self.routes[(method, path)] = handler
            return handler

        return register

    def run(self) -> None:
        routes = self.routes
        service = "/services/" + os.environ["GESTALTS_PLUGIN_ID"]

        class Handler(BaseHTTPRequestHandler):
            def _send(self, status: int, content_type: str, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle(self) -> None:
                url = urllib.parse.urlsplit(self.path)
                if url.path == "/_gestalts/health":
                    self._send(200, "application/json", b'{"protocol":1}')
                    return
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                path = url.path.removeprefix(service) or "/"
                handler = routes.get((self.command, path))
                if handler is None:
                    self._send(404, "text/plain", b"not found")
                    return
                body: Any = raw
                if "json" in self.headers.get("Content-Type", ""):
                    body = json.loads(raw or b"null")
                elif self.command == "GET":
                    body = dict(urllib.parse.parse_qsl(url.query))
                try:
                    result = handler(body)
                except Exception as error:
                    self._send(500, "application/json", json.dumps({"error": f"{type(error).__name__}: {error}"}).encode())
                    return
                if isinstance(result, tuple):
                    self._send(*result)
                else:
                    self._send(200, "application/json", json.dumps(result).encode())

            do_GET = do_POST = do_PUT = do_DELETE = _handle

            def log_message(self, format: str, *args: Any) -> None:
                print(f"[{os.environ['GESTALTS_PLUGIN_ID']}] {format % args}", flush=True)

        ThreadingHTTPServer(("127.0.0.1", int(os.environ["GESTALTS_WORKER_PORT"])), Handler).serve_forever()
