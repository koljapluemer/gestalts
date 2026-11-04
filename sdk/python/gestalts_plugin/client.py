import json
import os
import urllib.error
import urllib.parse
import urllib.request


class ConnectorClient:
    def __init__(self, base_url: str | None = None, token: str | None = None):
        self.base_url = (base_url or os.environ["GESTALTS_CONNECTOR_URL"]).rstrip("/")
        self.token = token or os.environ["GESTALTS_PLUGIN_TOKEN"]

    def _request(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> bytes:
        request = urllib.request.Request(self.base_url + path, data=body, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if content_type:
            request.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise RuntimeError(f"connector returned {error.code}: {detail}") from error

    def notes(self) -> list[dict[str, str]]:
        return json.loads(self._request("GET", "/notes"))

    def read_note(self, key: str) -> str | None:
        try:
            return self._request("GET", "/notes/" + urllib.parse.quote(key, safe="")).decode()
        except RuntimeError as error:
            if "returned 404" in str(error):
                return None
            raise

    def write_note(self, key: str, yaml: str) -> None:
        self._request("PUT", "/notes/" + urllib.parse.quote(key, safe=""), yaml.encode(), "application/yaml")

    def delete_note(self, key: str) -> None:
        """Deletes the note: the connector writes its tombstone, so the delete syncs."""
        self._request("DELETE", "/notes/" + urllib.parse.quote(key, safe=""))

    def read_blob(self, name: str) -> bytes | None:
        """None when it's missing, or not readable for this worker (not referenced by a note it may read)."""
        try:
            return self._request("GET", "/blobs/" + urllib.parse.quote(name, safe=""))
        except RuntimeError as error:
            if "returned 404" in str(error):
                return None
            raise

    def write_blob(self, name: str, data: bytes) -> None:
        self._request("PUT", "/blobs/" + urllib.parse.quote(name, safe=""), data, "application/octet-stream")
