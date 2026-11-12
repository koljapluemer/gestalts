"""One build of one viz, apart from the server, so it can be tested: the workspace, the CLI's command line, reading
its stream, and what comes back.

A workspace per viz holds the template (the contract, check.ts, check.py), the examples, a link to @gestalts/viz's
sources, SPEC.md, the previous viz.ts, files/ and package.json. Only viz.ts and package.json come back, with the
built page and its still when the check passed.
"""

import base64
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
TEMPLATE = Path(os.environ.get("VIZINT_TEMPLATE", REPO / "apps" / "vizint-workshop" / "agent-template"))
VIZ_PACKAGE = Path(os.environ.get("VIZINT_VIZ_PACKAGE", REPO / "packages" / "viz"))
WORKSPACES = Path(os.environ.get("VIZINT_WORKSPACES", Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "vizint-workshop" / "workspaces"))
CLAUDE = os.environ.get("VIZINT_CLAUDE", "claude")
GENERATOR = "vizint-agent-1"

TEMPLATE_FILES = ["CLAUDE.md", "check.ts", "check.py"]
TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(npm install:*)", "Bash(npm uninstall:*)", "Bash(node check.ts)", "Bash(node check.ts:*)"]
SYSTEM = ("You build one visualization in this directory. CLAUDE.md here is the contract: read it first. "
          "Only viz.ts and package.json are kept; run `node check.ts` before you finish.")
VIZ_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
PACKAGE = re.compile(r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+[0-9A-Za-z.+-]*$")
CHECK_TIMEOUT_S = 300


class Invalid(ValueError):
    """A request the backend refuses (400)."""


def env() -> dict[str, str]:
    """What the CLI and the check run with: where @gestalts/viz is."""
    return os.environ | {"VIZ_PACKAGE": str(VIZ_PACKAGE)}


def packages_json(packages: list[str]) -> str:
    deps = {}
    for p in packages:
        if not isinstance(p, str) or not PACKAGE.match(p):
            raise Invalid(f"packages: {p!r} isn't name@exact-version")
        name, version = p.rsplit("@", 1)
        deps[name] = version
    return json.dumps({"private": True, "type": "module", "dependencies": deps}, indent=2) + "\n"


def packages_of(text: str) -> list[str]:
    """The packages a workspace's package.json names, as name@version; ranges lose their ^ or ~."""
    try:
        deps = json.loads(text).get("dependencies") or {}
    except (json.JSONDecodeError, AttributeError):
        return []
    return sorted(f"{n}@{str(v).lstrip('^~=')}" for n, v in deps.items() if isinstance(v, str))


def validate(req: dict) -> None:
    if not isinstance(req.get("viz"), str) or not VIZ_ID.match(req["viz"]):
        raise Invalid("viz: lowercase letters, digits and -")
    if not isinstance(req.get("spec"), str) or not req["spec"].strip():
        raise Invalid("the spec is empty")
    files = req.get("files") or {}
    if not isinstance(files, dict) or not all(isinstance(k, str) and FILE_NAME.match(k) and isinstance(v, str) for k, v in files.items()):
        raise Invalid("files: {name: base64}, plain file names")
    packages_json(req.get("packages") or [])


def prepare(workspace: Path, req: dict) -> bool:
    """Lays out the workspace for a build of `req`; whether npm has packages to install."""
    workspace.mkdir(parents=True, exist_ok=True)
    for p in workspace.iterdir():
        if p.name in ("node_modules", ".vizint"):
            continue
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p)
        else:
            p.unlink()
    for name in TEMPLATE_FILES:
        shutil.copy2(TEMPLATE / name, workspace / name)
    shutil.copytree(VIZ_PACKAGE / "examples", workspace / "examples", ignore=shutil.ignore_patterns("dist"))
    (workspace / "viz-sources").symlink_to(VIZ_PACKAGE / "src", target_is_directory=True)
    title = req.get("title") if isinstance(req.get("title"), str) else ""
    (workspace / "SPEC.md").write_text(f"# {title}\n\n{req['spec'].strip()}\n" if title else req["spec"].strip() + "\n")
    if isinstance(req.get("source"), str) and req["source"].strip():
        (workspace / "viz.ts").write_text(req["source"])
    files = req.get("files") or {}
    if files:
        (workspace / "files").mkdir()
        for name, b64 in files.items():
            (workspace / "files" / name).write_bytes(base64.b64decode(b64))
    packages = req.get("packages") or []
    (workspace / "package.json").write_text(packages_json(packages))
    return bool(packages)


def prompt(req: dict) -> str:
    if isinstance(req.get("source"), str) and req["source"].strip():
        return ("Build the visualization SPEC.md describes, starting from the previous version in viz.ts: keep what works "
                "and change what the spec requires.")
    return "Build the visualization SPEC.md describes."


def command(model: str | None = None, budget: str | None = None) -> list[str]:
    cmd = [CLAUDE, "-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
           "--append-system-prompt", SYSTEM, "--allowedTools", *TOOLS]
    if model:
        cmd += ["--model", model]
    if budget:
        cmd += ["--max-budget-usd", budget]
    return cmd


def summary(name: str, args: dict, workspace: Path) -> str:
    for key in ("file_path", "path"):
        if isinstance(args.get(key), str):
            p = args[key]
            return p[len(str(workspace)) + 1:] if p.startswith(str(workspace) + "/") else p
    for key in ("command", "pattern"):
        if isinstance(args.get(key), str):
            return args[key][:200]
    return ""


def events_of(e: dict, workspace: Path) -> list[dict]:
    """What one line of the CLI's stream says, for the browser."""
    kind = e.get("type")
    out: list[dict] = []
    if kind == "assistant":
        for c in e.get("message", {}).get("content", []):
            if c.get("type") == "text" and c.get("text"):
                out.append({"type": "text", "text": c["text"]})
            elif c.get("type") == "tool_use":
                out.append({"type": "tool", "name": c.get("name", ""), "summary": summary(c.get("name", ""), c.get("input") or {}, workspace)})
    elif kind == "result":
        for d in e.get("permission_denials") or []:
            what = summary(d.get("tool_name", ""), d.get("tool_input") or {}, workspace)
            out.append({"type": "tool", "name": d.get("tool_name", "?"), "summary": f"(not allowed here) {what}".strip()})
    return out


def check(workspace: Path) -> tuple[bool, str]:
    """The final check, run by the backend whatever the agent said."""
    try:
        r = subprocess.run(["node", "check.ts"], cwd=workspace, env=env(), capture_output=True, text=True, timeout=CHECK_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return False, f"the check took more than {CHECK_TIMEOUT_S} s"
    except FileNotFoundError as error:
        return False, f"cannot run node: {error}"
    return r.returncode == 0, (r.stdout + r.stderr).strip()


def collect(workspace: Path, passed: bool) -> dict:
    """What the build made: always the source, and the page and its still only when the check passed."""
    source = workspace / "viz.ts"
    pkg = workspace / "package.json"
    out: dict = {
        "source": source.read_text() if source.is_file() else None,
        "packages": packages_of(pkg.read_text()) if pkg.is_file() else [],
    }
    page, still = workspace / "dist" / "index.html", workspace / "still.png"
    if passed and page.is_file():
        out["built"] = page.read_text()
        if still.is_file():
            out["still"] = base64.b64encode(still.read_bytes()).decode()
    return out
