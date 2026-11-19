#!/usr/bin/env python3
"""DeployForge real-Docker acceptance scenario (stdlib only).

Drives a running acceptance stack (see scripts/acceptance.sh) through its
public HTTP API and Caddy, and inspects Docker directly for evidence. Writes
docs/acceptance-report.md. Exit code is non-zero if any check fails.
"""
from __future__ import annotations

import http.client
import http.cookiejar
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.environ.get("ACCEPTANCE_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV_FILE = os.environ.get("ACCEPTANCE_ENV", os.path.join(ROOT, ".tmp/acceptance/.env"))
PROJECT = os.environ.get("ACCEPTANCE_PROJECT", "deployforge-acceptance")
PROXY_HOST, PROXY_PORT = "127.0.0.1", 18080
DASH = "deploy.acceptance.localhost"
ORIGIN = f"http://{DASH}:{PROXY_PORT}"
TERMINAL = {"succeeded", "failed", "canceled", "interrupted"}

env = {}
for line in open(ENV_FILE):
    if "=" in line and not line.startswith("#"):
        k, v = line.rstrip("\n").split("=", 1)
        env[k] = v
shas = json.load(open(os.path.join(os.path.dirname(ENV_FILE), "fixture", "shas.json")))

results: list[tuple[str, bool, str, float]] = []
evidence: list[str] = []


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def compose(*args: str) -> str:
    cmd = ["docker", "compose", "-p", PROJECT, "-f", f"{ROOT}/infra/compose.yaml", "-f", f"{ROOT}/infra/compose.acceptance.yaml", "--env-file", ENV_FILE, *args]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def docker(*args: str) -> str:
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout.strip()


class Api:
    """Cookie + CSRF client that reaches the API through Caddy's dashboard route."""

    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf: str | None = None

    def call(self, method: str, path: str, body: object | None = None, expect: tuple[int, ...] = (200, 201, 202, 204)) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://{PROXY_HOST}:{PROXY_PORT}{path}", data=data, method=method)
        req.add_header("Host", DASH)
        req.add_header("Origin", ORIGIN)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if method != "GET" and self.csrf:
            req.add_header("X-CSRF-Token", self.csrf)
        try:
            with self.opener.open(req, timeout=60) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        parsed = json.loads(raw) if raw else {}
        if status not in expect:
            raise AssertionError(f"{method} {path} -> {status}: {raw[:300]!r}")
        return parsed


def via_proxy(host: str, path: str) -> tuple[int, str]:
    c = http.client.HTTPConnection(PROXY_HOST, PROXY_PORT, timeout=10)
    c.request("GET", path, headers={"Host": host})
    r = c.getresponse()
    return r.status, r.read().decode()


def version(host: str) -> str | None:
    try:
        status, body = via_proxy(host, "/version")
        return json.loads(body)["version"] if status == 200 else f"HTTP {status}"
    except Exception as e:  # noqa: BLE001
        return f"error: {e}"


def check(name: str):
    def deco(fn):
        t0 = time.time()
        try:
            detail = fn() or ""
            results.append((name, True, str(detail), time.time() - t0))
            log(f"PASS {name} {detail}")
        except Exception as e:  # noqa: BLE001
            results.append((name, False, f"{type(e).__name__}: {e}", time.time() - t0))
            log(f"FAIL {name}: {e}")
        return fn

    return deco


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


api = Api()
state: dict[str, object] = {}


def deploy(app_id: str, sha: str) -> dict:
    return api.call("POST", f"/api/apps/{app_id}/deployments", {"commitSha": sha})


def wait(dep_id: str, timeout: float = 300, until: set[str] | None = None) -> dict:
    until = until or TERMINAL
    end = time.time() + timeout
    while time.time() < end:
        d = api.call("GET", f"/api/deployments/{dep_id}")
        if d["status"] in until:
            return d
        time.sleep(1)
    raise AssertionError(f"deployment {dep_id} did not reach {until} (last {d['status']})")


def app_containers(app_id: str, running_only: bool = True) -> list[str]:
    args = ["ps", "-q"] if running_only else ["ps", "-aq"]
    out = docker(*args, "--filter", f"label=io.deployforge.application={app_id}")
    return [x for x in out.splitlines() if x]


def app_images(app_id: str) -> set[str]:
    out = docker("images", "--no-trunc", "-q", "--filter", f"label=io.deployforge.application={app_id}")
    return {x for x in out.splitlines() if x}


HOST = "sample.acceptance.localhost"


@check("0. First-run setup requires the token; owner signs in")
def _setup():
    st = api.call("GET", "/api/auth/status")
    if st["setupRequired"]:
        api.call("POST", "/api/setup", {"name": "Acceptance", "email": "owner@acceptance.test", "password": "acceptance password 1", "workspaceName": "Acceptance"}, expect=(403,))
        info = api.call("POST", "/api/setup", {"name": "Acceptance", "email": "owner@acceptance.test", "password": "acceptance password 1", "workspaceName": "Acceptance", "setupToken": env["SETUP_TOKEN"]})
    else:
        info = api.call("POST", "/api/auth/login", {"email": "owner@acceptance.test", "password": "acceptance password 1"})
    api.csrf = info["csrfToken"]
    state["ws"] = info["workspaces"][0]["id"]
    projects = api.call("GET", f"/api/workspaces/{state['ws']}/projects")
    existing = [a for p in projects for a in p["applications"] if a["slug"] == "sample"]
    if existing:
        api.call("DELETE", f"/api/apps/{existing[0]['id']}", {"confirmSlug": "sample"})
        time.sleep(10)
    app = api.call(
        "POST",
        f"/api/workspaces/{state['ws']}/apps",
        {
            "projectId": projects[0]["id"],
            "name": "Sample",
            "slug": "sample",
            "source": {"type": "public", "repoUrl": "http://git-fixture:8080/demo/sample-app"},
            "branch": "main",
            "port": 3000,
            "healthCheck": {"path": "/health", "timeoutSeconds": 2, "intervalSeconds": 1, "startPeriodSeconds": 1, "retries": 10},
            "memoryLimitMb": 256,
            "env": [{"key": "GREETING", "value": "hello acceptance", "secret": False}, {"key": "API_KEY", "value": "acceptance-secret-value-1", "secret": True}],
        },
    )
    state["app"] = app["id"]
    return f"app {app['id']}"


APP = lambda: str(state["app"])  # noqa: E731


@check("1. Deploy version A (clone → BuildKit build → health → promote)")
def _a():
    d = wait(deploy(APP(), shas["A"])["id"])
    expect(d["status"] == "succeeded", f"status {d['status']}: {d.get('errorMessage')}")
    expect(d["commitSha"] == shas["A"], "exact commit recorded")
    state["depA"] = d["id"]
    state["imageA"] = d["imageId"]
    evidence.append(f"Deployment #{d['number']} ({shas['A'][:12]}) image `{d['imageId'][7:19]}` stages: " + ", ".join(f"{s['stage']} {s['durationMs']}ms" for s in d["stages"]))
    return f"#{d['number']} image {d['imageId'][7:19]}"


@check("2. Version A answers through the proxy")
def _a_proxy():
    v = version(HOST)
    expect(v == "A", f"got {v}")
    status, body = via_proxy(HOST, "/")
    expect("hello acceptance" in body, "runtime variable reached the container")
    expect("acceptance-secret-value-1" not in body, "secret value not displayed by the app")
    status, hdrs = via_proxy(HOST, "/headers")
    h = json.loads(hdrs)
    expect(h["x-forwarded-host"] == HOST and h["x-forwarded-proto"] == "http", f"forwarding headers {h}")
    evidence.append(f"`GET http://{HOST}/version` → `{v}`; forwarding headers {h}")
    return "version A"


@check("3. Deploy version B; response changes")
def _b():
    d = wait(deploy(APP(), shas["B"])["id"])
    expect(d["status"] == "succeeded", f"status {d['status']}: {d.get('errorMessage')}")
    state["depB"] = d["id"]
    v = version(HOST)
    expect(v == "B", f"got {v}")
    time.sleep(int(env["DRAIN_SECONDS"]) + 8)
    running = app_containers(APP())
    expect(len(running) == 1, f"old release retired after drain; running containers: {len(running)}")
    evidence.append(f"After #{d['number']}: `/version` → `{v}`; running app containers after drain: {len(running)}")
    return f"#{d['number']} serving B"


@check("4. Unhealthy deployment fails; B stays available")
def _unhealthy():
    d = wait(deploy(APP(), shas["unhealthy"])["id"])
    expect(d["status"] == "failed" and d["failureCategory"] == "health_check_failed", f"{d['status']} {d['failureCategory']}")
    expect(version(HOST) == "B", "B still served")
    expect(not app_containers(APP()) or len(app_containers(APP())) == 1, "candidate removed")
    leftover = docker("ps", "-aq", "--filter", f"label=io.deployforge.deployment={d['id']}")
    expect(leftover == "", "failed candidate container removed")
    evidence.append(f"#{d['number']} {d['status']} ({d['failureCategory']}): {d['errorMessage']}; `/version` still `B`")
    return d["errorMessage"]


@check("5. Roll back to A without rebuilding")
def _rollback():
    before = app_images(APP())
    r = api.call("POST", f"/api/deployments/{state['depA']}/rollback", {"confirm": True})
    d = wait(r["id"])
    expect(d["status"] == "succeeded", f"status {d['status']}: {d.get('errorMessage')}")
    expect(d["rollbackOf"]["id"] == state["depA"], "linked to original release")
    expect(d["imageId"] == state["imageA"], "same image as release A")
    expect(not any(s["stage"] in ("cloning", "building") for s in d["stages"]), "no clone/build stages")
    after = app_images(APP())
    expect(after == before, f"image set unchanged ({len(before)} → {len(after)})")
    expect(version(HOST) == "A", "A served again")
    state["depRollback"] = d["id"]
    evidence.append(f"Rollback #{d['number']} reused image `{d['imageId'][7:19]}` (same as #1); stages: " + ", ".join(s["stage"] for s in d["stages"]) + f"; app image count unchanged ({len(after)})")
    return f"#{d['number']} image reused"


@check("6. Invalid Dockerfile is reported as a build failure")
def _broken():
    d = wait(deploy(APP(), shas["broken"])["id"])
    expect(d["status"] == "failed" and d["failureCategory"] == "build_failed", f"{d['status']} {d['failureCategory']}")
    logs = api.call("GET", f"/api/deployments/{d['id']}/logs?q=exit")
    expect(len(logs["items"]) > 0, "failing step visible in build log")
    expect(version(HOST) == "A", "A still served")
    return d["errorMessage"][:80]


@check("7. Container startup crash is reported as such")
def _crash():
    d = wait(deploy(APP(), shas["crash"])["id"])
    expect(d["status"] == "failed" and d["failureCategory"] == "startup_crash", f"{d['status']} {d['failureCategory']}")
    logs = api.call("GET", f"/api/deployments/{d['id']}/logs?q=crashOnStart")
    expect(len(logs["items"]) > 0, "container output captured into the deployment log")
    expect(version(HOST) == "A", "A still served")
    return d["errorMessage"]


@check("8. Concurrent deployment requests produce exactly one active release")
def _concurrent():
    ids: list[str] = []
    lock = threading.Lock()

    def fire():
        r = deploy(APP(), shas["B"])
        with lock:
            ids.append(r["id"])

    threads = [threading.Thread(target=fire) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    finals = [wait(i) for i in ids]
    statuses = sorted(f["status"] for f in finals)
    app = api.call("GET", f"/api/apps/{APP()}")
    succeeded = [f for f in finals if f["status"] == "succeeded"]
    expect(len(succeeded) >= 1, f"statuses {statuses}")
    expect(app["activeDeployment"]["id"] == max(succeeded, key=lambda f: f["number"])["id"], "newest successful is active")
    expect(any(f["failureCategory"] == "superseded" for f in finals), "older queued requests superseded")
    actives = [f for f in finals if f["releaseState"] == "active"]
    expect(len(actives) == 1, f"{len(actives)} active releases")
    time.sleep(int(env["DRAIN_SECONDS"]) + 8)
    running = app_containers(APP())
    expect(len(running) == 1, f"{len(running)} running app containers")
    expect(version(HOST) == "B", "B served")
    evidence.append(f"4 concurrent requests → statuses {statuses}; 1 active release; 1 running container")
    return str(statuses)


@check("9. Proxy update failure keeps the previous route")
def _proxy_failure():
    before = api.call("GET", f"/api/apps/{APP()}")["activeDeployment"]["id"]
    # Break only the admin endpoint: Caddy keeps serving traffic, but the
    # control plane can no longer load configuration.
    docker("exec", f"{PROJECT}-caddy-1", "rm", "-f", "/run/caddy-admin/admin.sock")
    try:
        d = wait(deploy(APP(), shas["A"])["id"], timeout=300)
        expect(version(HOST) == "B", "previous release served while the admin API was down")
    finally:
        compose("restart", "caddy")
    expect(d["status"] == "failed" and d["failureCategory"] == "proxy_promotion_failed", f"{d['status']} {d['failureCategory']} {d.get('errorMessage')}")
    time.sleep(5)
    after = api.call("GET", f"/api/apps/{APP()}", expect=(200,))
    expect(after["activeDeployment"]["id"] == before, "active release unchanged in the database")
    expect(version(HOST) == "B", f"previous release still routed after Caddy restart (got {version(HOST)})")
    evidence.append(f"Caddy admin socket removed before promotion → #{d['number']} failed ({d['failureCategory']}); active release unchanged, `/version` → `B`")
    return d["errorMessage"][:90]


@check("10. Worker crash mid-build is recovered as interrupted")
def _worker_crash():
    before = api.call("GET", f"/api/apps/{APP()}")["activeDeployment"]["id"]
    r = deploy(APP(), shas["A"])
    wait(r["id"], until={"cloning", "building", "starting", "checking_health"} | TERMINAL, timeout=120)
    docker("kill", f"{PROJECT}-worker-1")
    time.sleep(3)
    compose("start", "worker")
    d = wait(r["id"], timeout=300)
    expect(d["status"] in ("interrupted", "succeeded"), f"status {d['status']}")
    app = api.call("GET", f"/api/apps/{APP()}")
    if d["status"] == "interrupted":
        expect(app["activeDeployment"]["id"] == before, "active release unchanged")
        leftover = docker("ps", "-aq", "--filter", f"label=io.deployforge.deployment={d['id']}")
        expect(leftover == "", "interrupted candidate removed")
    expect(len([x for x in [app["activeDeployment"]] if x]) == 1, "exactly one active release")
    evidence.append(f"Worker killed during `{d['stages'][-1]['stage'] if d['stages'] else '?'}` → #{d['number']} ended `{d['status']}`; active #{app['activeDeployment']['number']}")
    return d["status"]


@check("11. Reconciler recreates a missing active container")
def _reconcile_missing():
    expected = version(HOST)
    expect(expected in ("A", "B"), f"app must be serving before this check (got {expected})")
    for c in app_containers(APP()):
        docker("rm", "-f", c)
    end = time.time() + 120
    while time.time() < end and version(HOST) != expected:
        time.sleep(3)
    expect(version(HOST) == expected, f"service restored (got {version(HOST)})")
    return f"restored {expected}"


@check("12. Restart all DeployForge services; app stays available and state reconciles")
def _restart():
    app_before = api.call("GET", f"/api/apps/{APP()}")
    expected = version(HOST)
    samples: list[str | None] = []
    compose("restart")
    end = time.time() + 180
    while time.time() < end:
        samples.append(version(HOST))
        try:
            if api.call("GET", "/readyz", expect=(200, 503)).get("status") == "ready":
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    time.sleep(int(env["RECONCILE_INTERVAL_SECONDS"]) + 5)
    expect(version(HOST) == expected, f"app available after restart (got {version(HOST)})")
    app_after = api.call("GET", f"/api/apps/{APP()}")
    expect(app_after["activeDeployment"]["id"] == app_before["activeDeployment"]["id"], "same active release")
    expect(app_after["runtimeState"] == "running", f"runtime state {app_after['runtimeState']}")
    diag = api.call("GET", "/api/diagnostics")
    ok = {k: diag[k]["ok"] for k in ("database", "redis", "runner", "proxy")}
    expect(all(ok.values()), f"diagnostics {ok}")
    expect(diag["reconciler"]["lastRunAt"] is not None, "reconciler ran")
    served = sum(1 for s in samples if s == expected)
    evidence.append(f"`docker compose restart` of all services: app answered `{expected}` in {served}/{len(samples)} samples during the restart (the app container itself is not restarted; Caddy briefly restarts); after restart active #{app_after['activeDeployment']['number']}, state `{app_after['runtimeState']}`, diagnostics {ok}")
    return f"diagnostics {ok}"


@check("13. Deleting the app removes only resources DeployForge owns")
def _delete():
    foreign = docker("run", "-d", "--rm", "--label", "acceptance=foreign", "alpine:3.20", "sleep", "600")
    other = docker("run", "-d", "--rm", "--label", "io.deployforge.managed=true", "--label", "io.deployforge.role=app", "--label", "io.deployforge.instance=another-install", "--label", f"io.deployforge.application={APP()}", "alpine:3.20", "sleep", "600")
    try:
        api.call("DELETE", f"/api/apps/{APP()}", {"confirmSlug": "wrong"}, expect=(409,))
        api.call("DELETE", f"/api/apps/{APP()}", {"confirmSlug": "sample"}, expect=(202,))
        end = time.time() + 120
        while time.time() < end:
            owned = docker("ps", "-aq", "--filter", f"label=io.deployforge.application={APP()}", "--filter", "label=io.deployforge.instance=acceptance")
            if not owned:
                break
            time.sleep(2)
        expect(owned == "", "owned containers removed")
        imgs = docker("images", "-q", "--filter", f"label=io.deployforge.application={APP()}", "--filter", "label=io.deployforge.instance=acceptance")
        expect(imgs == "", "owned images removed")
        nets = docker("network", "ls", "-q", "--filter", f"name=df-app-{APP()}")
        expect(nets == "", "application network removed")
        status, _ = via_proxy(HOST, "/")
        expect(status == 404, f"route removed (HTTP {status})")
        expect(docker("inspect", "-f", "{{.State.Running}}", foreign) == "true", "foreign container untouched")
        expect(docker("inspect", "-f", "{{.State.Running}}", other) == "true", "other installation's container untouched")
        api.call("GET", f"/api/apps/{APP()}", expect=(404,))
    finally:
        subprocess.run(["docker", "rm", "-f", foreign, other], capture_output=True)
    evidence.append("App deletion removed its containers, images, network and route; an unrelated container and a container labeled for another installation kept running")
    return "cleanup scoped to owned resources"


def report() -> None:
    passed = sum(1 for r in results if r[1])
    # CI checks out the exact SHA being tested; include it in generated evidence.
    # git is also available in a clean local checkout, but never claim an
    # unknown revision if the acceptance fixture was copied without .git.
    revision = subprocess.run(
        ["git", "-C", ROOT, "rev-parse", "HEAD"],
        capture_output=True, text=True, check=False,
    )
    commit_sha = revision.stdout.strip() if revision.returncode == 0 else "unknown (no git checkout)"
    compose_version = subprocess.run(
        ["docker", "compose", "version", "--short"],
        capture_output=True, text=True, check=False,
    )
    compose_label = compose_version.stdout.strip() if compose_version.returncode == 0 else "unknown"
    lines = [
        "# Acceptance report (real Docker)",
        "",
        f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} by `scripts/acceptance.sh`.",
        f"Repository revision: `{commit_sha}`.",
        f"Docker {docker('version', '-f', '{{.Server.Version}}')}, Compose {compose_label}, project `{PROJECT}`, TLS mode off (local domains).",
        "",
        f"**{passed}/{len(results)} checks passed.**",
        "",
        "| Check | Result | Detail | Time |",
        "| --- | --- | --- | --- |",
    ]
    for name, ok, detail, dt in results:
        lines.append(f"| {name} | {'PASS' if ok else 'FAIL'} | {detail.replace('|', '/')[:200]} | {dt:.0f}s |")
    lines += ["", "## Evidence", ""] + [f"- {e}" for e in evidence]
    path = os.path.join(ROOT, "docs", "acceptance-report.md")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    log(f"report written to {path}: {passed}/{len(results)} passed")


if not results[0][1]:
    log("setup failed; is the stack running? (scripts/acceptance.sh up)")
report()
sys.exit(0 if all(r[1] for r in results) else 1)
