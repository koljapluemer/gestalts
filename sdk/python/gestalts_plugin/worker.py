import json
import os
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RunHandler = Callable[[dict], dict | None]
ServiceHandler = Callable[[str, str, bytes], tuple[int, str, bytes]]


class Worker:
    def __init__(self, run: RunHandler):
        self.run = run
        self.services: dict[str, ServiceHandler] = {}

    def service(self, service_id: str, handler: ServiceHandler) -> None:
        self.services[service_id] = handler


def run_worker(worker: Worker) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/_gestalts/health":
                self._send(200, "application/json", b'{"protocol":1}')
                return
            self._service(b"")

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            if self.path == "/_gestalts/runs":
                try:
                    result = worker.run(json.loads(body)) or {}
                    payload = (json.dumps({"type": "completed", **result}) + "\n").encode()
                    self._send(200, "application/x-ndjson", payload)
                except Exception as error:
                    payload = (json.dumps({"type": "failed", "error": f"{type(error).__name__}: {error}"}) + "\n").encode()
                    self._send(500, "application/x-ndjson", payload)
                return
            self._service(body)

        def _service(self, body: bytes) -> None:
            parts = self.path.split("/", 4)
            if len(parts) < 4 or parts[1] != "services" or parts[2] not in worker.services:
                self._send(404, "text/plain", b"not found")
                return
            status, content_type, response = worker.services[parts[2]](self.command, "/" + (parts[3] if len(parts) > 3 else ""), body)
            self._send(status, content_type, response)

        def log_message(self, format: str, *args) -> None:
            print(f"[{os.environ.get('GESTALTS_PLUGIN_ID', 'plugin')}] {format % args}", flush=True)

    port = int(os.environ["GESTALTS_WORKER_PORT"])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
