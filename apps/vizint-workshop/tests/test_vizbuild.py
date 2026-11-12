import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "vizint-agent"
sys.path.insert(0, str(PLUGIN))
import vizbuild  # noqa: E402


class PackagesTest(unittest.TestCase):
    def test_round_trip_and_ranges_lose_their_prefix(self):
        text = vizbuild.packages_json(["d3-scale@4.0.2", "@observablehq/plot@0.6.17"])
        self.assertEqual(json.loads(text)["dependencies"], {"d3-scale": "4.0.2", "@observablehq/plot": "0.6.17"})
        self.assertEqual(vizbuild.packages_of(text), ["@observablehq/plot@0.6.17", "d3-scale@4.0.2"])
        self.assertEqual(vizbuild.packages_of('{"dependencies": {"x": "^1.2.3"}}'), ["x@1.2.3"])
        self.assertEqual(vizbuild.packages_of("not json"), [])

    def test_refuses_what_isnt_an_exact_version(self):
        for bad in ["d3", "d3@^7", "d3@latest", "../x@1.0.0", 3]:
            with self.assertRaises(vizbuild.Invalid):
                vizbuild.packages_json([bad])


class ValidateTest(unittest.TestCase):
    def test_refuses_bad_requests(self):
        ok = {"viz": "viz-a", "spec": "a chart"}
        vizbuild.validate(ok)
        for bad in [{**ok, "viz": "../x"}, {**ok, "spec": "  "}, {**ok, "files": {"../a.png": ""}}, {**ok, "packages": ["d3"]}]:
            with self.assertRaises(vizbuild.Invalid):
                vizbuild.validate(bad)


class WorkspaceTest(unittest.TestCase):
    def test_prepare_lays_out_the_workspace_and_replaces_the_last_one(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d) / "viz-a"
            (ws / "node_modules").mkdir(parents=True)
            (ws / "stale.txt").write_text("from the last build")
            req = {"viz": "viz-a", "title": "A", "spec": "a chart", "source": "export default 1;\n",
                   "files": {"x.csv": base64.b64encode(b"1,2").decode()}, "packages": ["d3-scale@4.0.2"]}
            self.assertTrue(vizbuild.prepare(ws, req))
            self.assertFalse((ws / "stale.txt").exists())
            self.assertTrue((ws / "node_modules").is_dir())
            self.assertEqual((ws / "SPEC.md").read_text(), "# A\n\na chart\n")
            self.assertEqual((ws / "viz.ts").read_text(), "export default 1;\n")
            self.assertEqual((ws / "files" / "x.csv").read_bytes(), b"1,2")
            for name in vizbuild.TEMPLATE_FILES:
                self.assertTrue((ws / name).is_file(), name)
            self.assertTrue((ws / "viz-sources" / "index.ts").is_file())
            self.assertTrue((ws / "examples" / "bezier" / "viz.ts").is_file())
            self.assertFalse((ws / "examples" / "bezier" / "dist").exists())
            self.assertIn("starting from the previous version", vizbuild.prompt(req))
            self.assertFalse(vizbuild.prepare(ws, {"viz": "viz-a", "spec": "again"}))
            self.assertFalse((ws / "viz.ts").exists())
            self.assertEqual(vizbuild.prompt({"spec": "again"}), "Build the visualization SPEC.md describes.")

    def test_collect_hands_back_the_page_only_when_the_check_passed(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            (ws / "viz.ts").write_text("src")
            (ws / "package.json").write_text(vizbuild.packages_json([]))
            (ws / "dist").mkdir()
            (ws / "dist" / "index.html").write_text("<html>")
            (ws / "still.png").write_bytes(b"png")
            self.assertEqual(vizbuild.collect(ws, False), {"source": "src", "packages": []})
            got = vizbuild.collect(ws, True)
            self.assertEqual(got["built"], "<html>")
            self.assertEqual(base64.b64decode(got["still"]), b"png")


class StreamTest(unittest.TestCase):
    def test_turns_cli_events_into_browser_events(self):
        ws = Path("/w")
        e = {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "hi"},
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/w/viz.ts"}},
        ]}}
        self.assertEqual(vizbuild.events_of(e, ws), [{"type": "text", "text": "hi"}, {"type": "tool", "name": "Read", "summary": "viz.ts"}])
        denied = {"type": "result", "permission_denials": [{"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}]}
        self.assertEqual(vizbuild.events_of(denied, ws)[0]["summary"], "(not allowed here) rm -rf /")

    def test_command_restricts_tools_and_passes_model_and_budget(self):
        cmd = vizbuild.command("sonnet", "1")
        self.assertIn("--allowedTools", cmd)
        self.assertIn("Bash(node check.ts)", cmd)
        self.assertEqual(cmd[cmd.index("--model") + 1], "sonnet")
        self.assertEqual(cmd[cmd.index("--max-budget-usd") + 1], "1")
        self.assertNotIn("--model", vizbuild.command())


if __name__ == "__main__":
    unittest.main()
