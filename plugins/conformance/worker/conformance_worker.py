import json

from gestalts_plugin import ConnectorClient, Worker, run_worker


client = ConnectorClient()


def run(request: dict) -> dict:
    run_id = request["runId"]
    key = f"conformance-{run_id}"
    client.write_blob(f"{key}.txt", b"conformance")
    client.write_note(key, f"id: {key}\ntitle: Plugin conformance run\ntags: [plugin-conformance]\nstatus: completed\nblobs:\n  - file: {key}.txt\n")
    return {"written": key}


def echo(method: str, path: str, body: bytes):
    return 200, "application/json", json.dumps({"method": method, "path": path, "body": body.decode(errors="replace")}).encode()


worker = Worker(run)
worker.service("conformance-worker@1", echo)
run_worker(worker)
