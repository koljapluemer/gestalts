import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "workshop-agent"
sys.path.insert(0, str(PLUGIN))
from runlog import RunLog  # noqa: E402


class RunLogTest(unittest.TestCase):
    def test_writes_raw_trace_and_normalized_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = RunLog(root, "run-1", "view", "old-session", "hello", {"view.tsx": "abc"}, [{}])
            log.event({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read"}]}})
            log.event({"type": "result", "duration_ms": 12, "duration_api_ms": 8, "num_turns": 2,
                       "total_cost_usd": 0.25,
                       "usage": {"input_tokens": 10, "output_tokens": 4, "cache_read_input_tokens": 20}})
            record = log.finish(outcome="completed", session="new-session", exit_code=0, changed_files=1, error=None)
            self.assertEqual(record["schema"], "workshop-agent-run@2")
            self.assertEqual(record["outcome"], "completed")
            self.assertEqual(record["usage"], {"input_tokens": 10, "output_tokens": 4, "cache_read_tokens": 20})
            self.assertEqual(record["tools"], {"Read": 1})
            self.assertEqual(record["request"]["file_chars"], 3)
            self.assertEqual(record["timings"]["provider_ms"], 12)
            self.assertEqual(record["session_totals"], {"api_ms": 8, "cost_usd": 0.25})
            self.assertEqual(record["verification"], {"check": "not_run"})
            raw = list((root / ".workshop" / "runs" / record["raw"]).read_text().splitlines())
            self.assertEqual(len(raw), 2)
            summary = next((root / ".workshop" / "runs").glob("????-??-??.jsonl"))
            self.assertEqual(json.loads(summary.read_text())["run_id"], "run-1")

    def test_records_malformed_output_stderr_and_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = RunLog(root, "run-2", "view", None, "hello", {}, [])
            log.malformed("not json\n")
            log.stderr("bad news")
            record = log.finish(outcome="failed", session=None, exit_code=2, changed_files=0, error="failed")
            self.assertEqual(record["outcome"], "failed")
            raw = (root / ".workshop" / "runs" / record["raw"]).read_text()
            self.assertIn('\"unparsed\":\"not json\"', raw)
            self.assertIn('\"stream\":\"stderr\"', raw)

    def test_appends_concurrent_summaries_without_losing_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = [RunLog(root, f"run-{i}", "view", None, "hello", {}, []) for i in range(10)]
            threads = [threading.Thread(target=log.finish, kwargs={
                "outcome": "completed", "session": None, "exit_code": 0, "changed_files": 0, "error": None,
            }) for log in logs]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            summary = next((root / ".workshop" / "runs").glob("????-??-??.jsonl"))
            records = [json.loads(line) for line in summary.read_text().splitlines()]
            self.assertEqual({record["run_id"] for record in records}, {f"run-{i}" for i in range(10)})

    def test_records_latest_standalone_check_and_permission_warnings(self):
        with tempfile.TemporaryDirectory() as directory:
            log = RunLog(Path(directory), "run-check", "view", None, "hello", {}, [])
            for tool_id, failed in (("first", True), ("second", False)):
                log.event({"type": "assistant", "message": {"content": [{
                    "type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": "node check.ts"},
                }]}})
                log.event({"type": "user", "message": {"content": [{
                    "type": "tool_result", "tool_use_id": tool_id, "is_error": failed, "content": "result",
                }]}})
            # A denied compound command is not the contract's standalone final check.
            log.event({"type": "assistant", "message": {"content": [{
                "type": "tool_use", "id": "compound", "name": "Bash",
                "input": {"command": "sed -i x view.tsx && node check.ts"},
            }]}})
            log.event({"type": "result", "permission_denials": [{}, {}]})
            record = log.finish(outcome="completed", session="session", exit_code=0, changed_files=1, error=None)
            self.assertEqual(record["verification"], {"check": "passed"})
            self.assertEqual(record["warnings"], {"permission_denials": 2})

    def test_latest_failed_or_unfinished_check_is_not_reported_as_passed(self):
        with tempfile.TemporaryDirectory() as directory:
            log = RunLog(Path(directory), "run-check", "view", None, "hello", {}, [])
            for tool_id, failed in (("passed", False), ("failed", True)):
                log.event({"type": "assistant", "message": {"content": [{
                    "type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": "node check.ts"},
                }]}})
                log.event({"type": "user", "message": {"content": [{
                    "type": "tool_result", "tool_use_id": tool_id, "is_error": failed,
                }]}})
            self.assertEqual(log.finish(outcome="completed", session="session", exit_code=0,
                                        changed_files=0, error=None)["verification"], {"check": "failed"})

            interrupted = RunLog(Path(directory), "run-interrupted", "view", None, "hello", {}, [])
            interrupted.event({"type": "assistant", "message": {"content": [{
                "type": "tool_use", "id": "pending", "name": "Bash", "input": {"command": "node check.ts"},
            }]}})
            self.assertEqual(interrupted.finish(outcome="cancelled", session=None, exit_code=None,
                                                changed_files=0, error=None)["verification"], {"check": "failed"})


if __name__ == "__main__":
    unittest.main()
