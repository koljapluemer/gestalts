import importlib.util
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "agent_stats.py"
spec = importlib.util.spec_from_file_location("agent_stats", SCRIPT)
assert spec and spec.loader
agent_stats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_stats)


class AgentStatsTest(unittest.TestCase):
    def test_load_filter_and_summarize(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [
                {"schema": "workshop-agent-run@2", "run_id": "a", "view": "one", "outcome": "completed",
                 "session_out": "session-one", "started_at": "2099-01-01T00:00:00+00:00",
                 "timings": {"wall_ms": 100, "provider_ms": 60}, "usage": {"input_tokens": 5},
                 "session_totals": {"api_ms": 70, "cost_usd": 0.1}, "tools": {"Read": 2},
                 "verification": {"check": "passed"}, "warnings": {"permission_denials": 1}},
                {"schema": "workshop-agent-run@2", "run_id": "b", "view": "two", "outcome": "failed",
                 "session_out": "session-two", "started_at": "2099-01-01T00:00:00+00:00",
                 "timings": {"wall_ms": 200}, "tools": {}, "verification": {"check": "not_run"}},
            ]
            (root / "2099-01-01.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
            records = agent_stats.selected(agent_stats.load(root), "one", None)
            summary = agent_stats.summarize(records, 5)
            self.assertEqual(summary["runs"], 1)
            self.assertEqual(summary["wall_ms"], 100)
            self.assertEqual(summary["session_cost_usd"], 0.1)
            self.assertEqual(summary["permission_denials"], 1)
            self.assertEqual(summary["tools"], {"Read": 2})
            self.assertIn(f"Logs: {root.resolve()}", agent_stats.human(summary, root))

    def test_cumulative_session_totals_are_not_summed_per_turn(self):
        records = [
            {"run_id": "first", "view": "view", "outcome": "completed", "session_out": "same",
             "timings": {"wall_ms": 100, "provider_ms": 90}, "session_totals": {"api_ms": 80, "cost_usd": .2}},
            {"run_id": "second", "view": "view", "outcome": "completed", "session_in": "same", "session_out": "same",
             "timings": {"wall_ms": 120, "provider_ms": 110}, "session_totals": {"api_ms": 180, "cost_usd": .35}},
        ]
        summary = agent_stats.summarize(records, 5)
        self.assertEqual(summary["wall_ms"], 220)
        self.assertEqual(summary["provider_ms"], 200)
        self.assertEqual(summary["session_api_ms"], 180)
        self.assertEqual(summary["session_cost_usd"], .35)
        self.assertEqual(summary["costliest_sessions"][0]["session"], "same")

    def test_legacy_records_are_skipped_with_one_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "2099-01-01.jsonl").write_text("\n".join((
                json.dumps({"schema": "workshop-agent-run@1", "run_id": "old-a"}),
                json.dumps({"schema": "workshop-agent-run@1", "run_id": "old-b"}),
            )) + "\n")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                records = agent_stats.load(root)
            self.assertEqual(records, [])
            self.assertEqual(stderr.getvalue().count("legacy workshop-agent-run@1"), 1)


if __name__ == "__main__":
    unittest.main()
