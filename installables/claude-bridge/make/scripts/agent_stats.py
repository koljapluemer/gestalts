#!/usr/bin/env python3
"""Summarize local workshop agent run records."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


def default_root() -> Path:
    workspaces = Path(os.environ.get("WORKSHOP_WORKSPACES", Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "gestalt-workshop" / "workspaces"))
    return workspaces / ".workshop" / "runs"


def load(root: Path) -> list[dict]:
    records = []
    legacy = 0
    for path in sorted(root.glob("????-??-??.jsonl")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            try:
                record = json.loads(line)
                if record.get("schema") == "workshop-agent-run@2":
                    records.append(record)
                elif record.get("schema") == "workshop-agent-run@1":
                    legacy += 1
            except (json.JSONDecodeError, AttributeError):
                print(f"warning: skipped malformed {path}:{number}", file=sys.stderr)
    if legacy:
        print(f"warning: skipped {legacy} legacy workshop-agent-run@1 record(s)", file=sys.stderr)
    return records


def selected(records: list[dict], view: str | None, days: int | None) -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days is not None else None
    result = []
    for record in records:
        if view and record.get("view") != view:
            continue
        try:
            started = datetime.fromisoformat(record["started_at"])
        except (KeyError, TypeError, ValueError):
            continue
        if cutoff is None or started >= cutoff:
            result.append(record)
    return result


def summarize(records: list[dict], limit: int) -> dict:
    outcomes = Counter(str(r.get("outcome", "unknown")) for r in records)
    checks = Counter(str((r.get("verification") or {}).get("check", "unknown")) for r in records)
    tools: Counter[str] = Counter()
    usage: Counter[str] = Counter()
    permission_denials = 0
    for record in records:
        tools.update(record.get("tools") or {})
        usage.update(record.get("usage") or {})
        permission_denials += int((record.get("warnings") or {}).get("permission_denials", 0) or 0)

    # Claude reports these values cumulatively for a resumed session. The latest record, rather than every turn, owns
    # the session total. A run without a session id remains its own session so incomplete/error records are not lost.
    sessions: dict[str, dict] = {}
    for record in records:
        key = str(record.get("session_out") or record.get("session_in") or record.get("run_id"))
        sessions[key] = record

    def timing(name: str) -> float:
        return sum(float((r.get("timings") or {}).get(name, 0) or 0) for r in records)

    def top(key):
        return [
            {"run_id": r.get("run_id"), "view": r.get("view"), "value": key(r)}
            for r in sorted(records, key=key, reverse=True)[:limit]
        ]

    def tokens(record: dict) -> float:
        return sum(float(value or 0) for value in (record.get("usage") or {}).values())

    return {
        "runs": len(records),
        "outcomes": dict(sorted(outcomes.items())),
        "checks": dict(sorted(checks.items())),
        "permission_denials": permission_denials,
        "wall_ms": timing("wall_ms"),
        "provider_ms": timing("provider_ms"),
        "session_api_ms": sum(float((r.get("session_totals") or {}).get("api_ms", 0) or 0) for r in sessions.values()),
        "usage": dict(sorted(usage.items())),
        "session_cost_usd": sum(float((r.get("session_totals") or {}).get("cost_usd", 0) or 0) for r in sessions.values()),
        "tools": dict(tools.most_common()),
        "slowest": top(lambda r: float((r.get("timings") or {}).get("wall_ms", 0) or 0)),
        "largest": top(tokens),
        "costliest_sessions": [
            {"session": key, "view": r.get("view"),
             "value": float((r.get("session_totals") or {}).get("cost_usd", 0) or 0)}
            for key, r in sorted(sessions.items(),
                                 key=lambda item: float((item[1].get("session_totals") or {}).get("cost_usd", 0) or 0),
                                 reverse=True)[:limit]
        ],
    }


def human(summary: dict, root: Path) -> str:
    lines = [
        f"Logs: {root.resolve()}",
        f"Runs: {summary['runs']}  Outcomes: {summary['outcomes']}",
        f"Verification: {summary['checks']}  Permission denials: {summary['permission_denials']}",
        f"Run time — wall: {summary['wall_ms'] / 1000:.1f}s  provider: {summary['provider_ms'] / 1000:.1f}s",
        f"Session totals — API: {summary['session_api_ms'] / 1000:.1f}s  cost: ${summary['session_cost_usd']:.4f}",
        f"Usage: {summary['usage']}",
        f"Tools: {summary['tools']}",
    ]
    for label in ("slowest", "largest"):
        lines.append(f"\n{label.title()}:")
        lines.extend(f"  {item['value']:.2f}  {item['view']}  {item['run_id']}" for item in summary[label])
    lines.append("\nCostliest Sessions:")
    lines.extend(f"  {item['value']:.2f}  {item['view']}  {item['session']}" for item in summary["costliest_sessions"])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=default_root())
    parser.add_argument("--days", type=int)
    parser.add_argument("--view")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    summary = summarize(selected(load(args.root), args.view, args.days), max(0, args.limit))
    if args.json:
        print(json.dumps({"logs": str(args.root.resolve()), **summary}, indent=2))
    else:
        print(human(summary, args.root))


if __name__ == "__main__":
    main()
