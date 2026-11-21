# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Builds one viz with the claude CLI (see vizbuild.py for the build itself).

The browser sends the viz's spec, its previous source, its files and packages; this lays out a workspace per viz, runs
`claude -p --output-format stream-json` there, then the check itself, and hands back what the agent said and did and,
at the end, a `result`: the source, the packages and, if the check passed, the built page and its still. It reads and
writes no ymls: the browser does.

- `POST /build` `{viz, title?, spec, source?, packages?, files?: {name: base64}}` -> 202 `{job}`; 409 while that viz builds
- `GET /events?job=&after=n` -> `{events, next, done}`, waiting up to 20 s for events after the `n`-th
- `POST /cancel` `{job}` -> `{}`
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
import uuid

from gestalts_backend import Backend

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vizbuild  # noqa: E402

EVENT_POLL_S = 20
FINISHED_JOB_KEEP_S = 600
MODEL = os.environ.get("VIZINT_MODEL") or None
BUDGET = os.environ.get("VIZINT_BUDGET_USD") or None


class Job:
    def __init__(self, viz: str):
        self.id = uuid.uuid4().hex
        self.viz = viz
        self.events: list[dict] = []
        self.done = False
        self.finished_at = 0.0
        self.process: subprocess.Popen | None = None
        self.cancelled = False
        self.cond = threading.Condition()

    def emit(self, event: dict) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    def finish(self) -> None:
        with self.cond:
            self.done = True
            self.finished_at = time.time()
            self.cond.notify_all()


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


def _json(status: int, body: object) -> tuple[int, str, bytes]:
    return status, "application/json", json.dumps(body).encode()


def _run(job: Job, req: dict) -> None:
    workspace = vizbuild.WORKSPACES / job.viz
    model, cost = None, None
    try:
        if vizbuild.prepare(workspace, req):
            job.emit({"type": "tool", "name": "npm", "summary": "install " + " ".join(req.get("packages") or [])})
            r = subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=workspace, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                job.emit({"type": "error", "message": f"npm install failed: {(r.stdout + r.stderr)[-2000:]}"})
        job.process = subprocess.Popen(vizbuild.command(MODEL, BUDGET), cwd=workspace, env=vizbuild.env(), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        assert job.process.stdin and job.process.stdout and job.process.stderr
        job.process.stdin.write(vizbuild.prompt(req))
        job.process.stdin.close()
        failed = None
        for line in job.process.stdout:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("type") == "system" and e.get("subtype") == "init":
                model = e.get("model") or model
            if e.get("type") == "result":
                cost = e.get("total_cost_usd")
                if e.get("is_error"):
                    failed = str(e.get("result") or e.get("subtype") or "the CLI reported an error")
            for out in vizbuild.events_of(e, workspace):
                job.emit(out)
        code = job.process.wait()
        stderr = job.process.stderr.read().strip()
        if job.cancelled:
            job.emit({"type": "error", "message": "stopped"})
            return
        if code != 0 and not failed:
            failed = f"claude exited with {code}" + (f": {stderr[-2000:]}" if stderr else "")
        if failed:
            job.emit({"type": "error", "message": failed})
        job.emit({"type": "tool", "name": "check", "summary": "node check.ts"})
        passed, report = vizbuild.check(workspace)
        generator = " ".join(x for x in (vizbuild.GENERATOR, model, f"${cost:.2f}" if isinstance(cost, (int, float)) else None) if x)
        job.emit({"type": "result", "ok": passed, "check": report, "generator": generator, **vizbuild.collect(workspace, passed)})
    except FileNotFoundError as error:
        job.emit({"type": "error", "message": f"cannot run {vizbuild.CLAUDE}: {error}"})
    except Exception as error:  # the browser must hear of it, or it waits forever
        job.emit({"type": "error", "message": f"{type(error).__name__}: {error}"})
    finally:
        job.emit({"type": "done"})
        job.finish()


def _prune() -> None:
    now = time.time()
    with _jobs_lock:
        for key in [k for k, j in _jobs.items() if j.done and now - j.finished_at > FINISHED_JOB_KEEP_S]:
            del _jobs[key]


backend = Backend()


@backend.route("/build")
def build(req: dict) -> tuple[int, str, bytes]:
    try:
        vizbuild.validate(req if isinstance(req, dict) else {})
    except vizbuild.Invalid as error:
        return _json(400, {"error": str(error)})
    _prune()
    with _jobs_lock:
        if any(j.viz == req["viz"] and not j.done for j in _jobs.values()):
            return _json(409, {"error": "this viz is being built"})
        job = Job(req["viz"])
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job, req), daemon=True).start()
    return _json(202, {"job": job.id})


@backend.route("/events", method="GET")
def events(query: dict) -> tuple[int, str, bytes]:
    job = _jobs.get(query.get("job", ""))
    if not job:
        return _json(404, {"error": "no such job"})
    try:
        after = max(0, int(query.get("after", "0")))
    except ValueError:
        after = 0
    with job.cond:
        job.cond.wait_for(lambda: len(job.events) > after or job.done, timeout=EVENT_POLL_S)
        return _json(200, {"events": job.events[after:], "next": len(job.events), "done": job.done})


@backend.route("/cancel")
def cancel(req: dict) -> tuple[int, str, bytes]:
    job = _jobs.get(req.get("job", "")) if isinstance(req, dict) else None
    if not job:
        return _json(404, {"error": "no such job"})
    job.cancelled = True
    if job.process and job.process.poll() is None:
        try:
            os.killpg(job.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    return _json(200, {})


backend.run()
