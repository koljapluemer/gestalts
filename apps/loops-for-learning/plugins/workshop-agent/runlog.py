"""Durable local records for workshop agent turns."""

from __future__ import annotations

import json
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_append_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _number(value: object) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


class RunLog:
    """Raw stream trace plus one normalized summary for a turn."""

    def __init__(self, root: Path, run_id: str, view: str, session: str | None,
                 message: str, files: dict[str, str], diagnostics: list) -> None:
        self.root = root / ".workshop" / "runs"
        self.run_id = run_id
        self.view = view
        self.session_in = session
        self.started_at = _now()
        self.started = time.monotonic()
        self.first_output_ms: int | None = None
        self.result: dict[str, Any] = {}
        self.tools: Counter[str] = Counter()
        self.check_tools: set[str] = set()
        self.check: str = "not_run"
        self.request = {
            "message_chars": len(message),
            "files": len(files),
            "file_chars": sum(len(text) for text in files.values()),
            "diagnostics": len(diagnostics),
            "resumed": session is not None,
        }
        day = self.started_at.date().isoformat()
        self.summary_path = self.root / f"{day}.jsonl"
        self.raw_path = self.root / "raw" / day / f"{run_id}.jsonl"

    def _raw(self, payload: dict[str, Any]) -> None:
        envelope = {
            "received_at": _now().isoformat(),
            "elapsed_ms": round((time.monotonic() - self.started) * 1000),
            **payload,
        }
        try:
            self.raw_path.parent.mkdir(parents=True, exist_ok=True)
            with self.raw_path.open("a", encoding="utf-8") as out:
                out.write(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError as error:
            print(f"workshop-agent: could not write raw run log: {error}", file=sys.stderr)

    def event(self, event: dict[str, Any]) -> None:
        self._raw({"stream": "stdout", "event": event})
        if event.get("type") == "assistant":
            if self.first_output_ms is None:
                self.first_output_ms = round((time.monotonic() - self.started) * 1000)
            for content in event.get("message", {}).get("content", []):
                if isinstance(content, dict) and content.get("type") == "tool_use":
                    self.tools[str(content.get("name") or "unknown")] += 1
                    if (content.get("name") == "Bash"
                            and (content.get("input") or {}).get("command", "").strip() == "node check.ts"
                            and isinstance(content.get("id"), str)):
                        self.check_tools.add(content["id"])
                        self.check = "failed"
        elif event.get("type") == "user":
            for content in event.get("message", {}).get("content", []):
                if (isinstance(content, dict) and content.get("type") == "tool_result"
                        and content.get("tool_use_id") in self.check_tools):
                    self.check = "passed" if content.get("is_error") is False else "failed"
        elif event.get("type") == "result":
            self.result = event

    def malformed(self, line: str) -> None:
        self._raw({"stream": "stdout", "unparsed": line.rstrip("\n")})

    def stderr(self, text: str) -> None:
        if text:
            self._raw({"stream": "stderr", "text": text})

    def finish(self, *, outcome: str, session: str | None, exit_code: int | None,
               changed_files: int, error: str | None) -> dict[str, Any]:
        usage = self.result.get("usage") if isinstance(self.result.get("usage"), dict) else {}
        timings = {"wall_ms": round((time.monotonic() - self.started) * 1000)}
        for source, target in (("duration_ms", "provider_ms"),):
            if (value := _number(self.result.get(source))) is not None:
                timings[target] = value
        if self.first_output_ms is not None:
            timings["first_output_ms"] = self.first_output_ms
        normalized_usage = {}
        for source, target in (
            ("input_tokens", "input_tokens"),
            ("output_tokens", "output_tokens"),
            ("cache_read_input_tokens", "cache_read_tokens"),
            ("cache_creation_input_tokens", "cache_creation_tokens"),
        ):
            if (value := _number(usage.get(source))) is not None:
                normalized_usage[target] = value
        record: dict[str, Any] = {
            "schema": "workshop-agent-run@2",
            "run_id": self.run_id,
            "session_in": self.session_in,
            "session_out": session,
            "view": self.view,
            "backend": "claude-cli",
            "started_at": self.started_at.isoformat(),
            "finished_at": _now().isoformat(),
            "outcome": outcome,
            "timings": timings,
            "tools": dict(sorted(self.tools.items())),
            "request": self.request,
            "result": {"exit_code": exit_code, "changed_files": changed_files, "error": error},
            "verification": {"check": self.check},
            "warnings": {"permission_denials": len(self.result.get("permission_denials") or [])},
            "raw": str(self.raw_path.relative_to(self.root)),
        }
        if normalized_usage:
            record["usage"] = normalized_usage
        if (value := _number(self.result.get("num_turns"))) is not None:
            record["turns"] = value
        session_totals = {}
        for source, target in (("duration_api_ms", "api_ms"), ("total_cost_usd", "cost_usd")):
            if (value := _number(self.result.get(source))) is not None:
                session_totals[target] = value
        if isinstance(self.result.get("modelUsage"), dict):
            session_totals["models"] = self.result["modelUsage"]
        if session_totals:
            record["session_totals"] = session_totals
        self.summary_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with _append_lock, self.summary_path.open("a", encoding="utf-8") as out:
            out.write(line)
        return record
