#!/usr/bin/env python3
"""Run a real-browser Flutter/Dart API check against disposable emulators.

This runner selects fresh loopback ports and owns only the child processes it
starts. An occupied port makes Firebase Emulator startup fail; it is never
reused or stopped by this script.
"""

from __future__ import annotations

import json
import os
import shlex
import secrets
import select
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PROJECT_ID = "demo-mmr-dev"
API_BUILD_TIMEOUT_SECONDS = 5 * 60
EMULATOR_RUN_TIMEOUT_SECONDS = 25 * 60
GCP_CREDENTIAL_ENV = (
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "FIREBASE_TOKEN",
    "FIREBASE_CONFIG",
    "FIREBASE_STORAGE_EMULATOR_PUBLIC_HOST",
    "GOOGLE_GHA_CREDS_PATH",
    "CREDENTIALS_DIRECTORY",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
)


def isolated_environment(
    home: Path,
    *,
    extra: dict[str, str] | None = None,
    firebase_emulator_cache: bool = False,
) -> dict[str, str]:
    """Expose a minimal environment and a private HOME/Cloud SDK config."""
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = home / ".config"
    cache = home / ".cache"
    tmp = home / "tmp"
    for directory in (config, cache, tmp):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    cloud_config = config / "gcloud"
    cloud_config.mkdir(mode=0o700, exist_ok=True)
    npm_user_config = home / ".npmrc"
    npm_user_config.touch(mode=0o600, exist_ok=True)

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(config),
        "XDG_CACHE_HOME": str(cache),
        "CLOUDSDK_CONFIG": str(cloud_config),
        "NPM_CONFIG_CACHE": str(cache / "npm"),
        "NPM_CONFIG_USERCONFIG": str(npm_user_config),
        "TMPDIR": str(tmp),
    }
    for key in (
        "LANG",
        "LC_ALL",
        "TZ",
        "JAVA_HOME",
    ):
        value = os.environ.get(key)
        if value:
            env[key] = value

    # Firebase's emulator cache contains only public emulator JAR/ZIP assets;
    # copy those files into this run's private HOME, never expose the host HOME.
    if firebase_emulator_cache:
        source = Path.home() / ".cache/firebase/emulators"
        target = cache / "firebase/emulators"
        if source.is_dir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            for artifact in source.iterdir():
                if artifact.is_file() and artifact.suffix in {".jar", ".zip"}:
                    shutil.copy2(artifact, target / artifact.name)

    if extra:
        env.update(extra)
    leaked = sorted(key for key in GCP_CREDENTIAL_ENV if key in env)
    if leaked:
        raise RuntimeError(f"Credential-related environment leaked into child: {leaked}")
    return env


def private_root() -> Path:
    raw = os.environ.get("CORS_TEST_PRIVATE_ROOT")
    if not raw:
        raise RuntimeError("Private test temporary root was not provided")
    root = Path(raw).resolve()
    if not root.is_dir():
        raise RuntimeError("Private test temporary root is unavailable")
    return root


def signal_to_cleanup(signum: int, _frame: object) -> None:
    raise KeyboardInterrupt(f"received signal {signum}")


def process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def process_group_has_live_members(pgid: int) -> bool:
    """Check /proc for non-zombie members without reaping the group leader."""
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return process_group_exists(pgid)
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text(encoding="ascii")
            fields = stat.rsplit(")", 1)[1].split()
            state, member_pgid = fields[0], int(fields[2])
        except (OSError, IndexError, ValueError):
            continue
        if member_pgid == pgid and state not in {"Z", "X"}:
            return True
    return False


def process_has_exited(process: subprocess.Popen[bytes]) -> bool:
    """Observe child exit without reaping it (the unreaped PID pins its PGID)."""
    result = os.waitid(
        os.P_PID,
        process.pid,
        os.WEXITED | os.WNOHANG | os.WNOWAIT,
    )
    return result is not None


def terminate_process_groups(
    processes: list[subprocess.Popen[bytes]], timeout: float = 8
) -> None:
    """TERM owned groups, KILL survivors, then reap their leaders.

    Every child is started in a fresh session, so its PID is also its PGID.
    Leaders are not waited/reaped until group signaling completes; this pins
    each PGID and avoids signaling an unrelated group after PID reuse.
    """
    groups: list[tuple[subprocess.Popen[bytes], int]] = []
    for process in processes:
        if process.returncode is not None:
            continue  # Never use a numeric PGID after this Popen was reaped.
        try:
            pgid = os.getpgid(process.pid)
        except ProcessLookupError:
            continue  # Already reaped: there is no safe numeric PGID to signal.
        if pgid != process.pid:
            raise RuntimeError("Refusing to signal a child outside its owned process group")
        groups.append((process, pgid))

    for _process, pgid in groups:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and any(
        process_group_has_live_members(pgid) for _process, pgid in groups
    ):
        time.sleep(0.05)

    survivors = [
        (process, pgid)
        for process, pgid in groups
        if process_group_has_live_members(pgid)
    ]
    for _process, pgid in survivors:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    kill_deadline = time.monotonic() + 5
    while time.monotonic() < kill_deadline and any(
        process_group_has_live_members(pgid) for _process, pgid in survivors
    ):
        time.sleep(0.05)

    # Uninterruptible kernel tasks can still outlive this bounded best effort.
    for process, _pgid in groups:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def terminate_process_group(process: subprocess.Popen[bytes], timeout: float = 8) -> None:
    terminate_process_groups([process], timeout=timeout)


def wait_with_cleanup(
    process: subprocess.Popen[bytes],
    *,
    timeout: float,
    description: str,
    cleanup_timeout: float = 8,
) -> int:
    """Bound a child wait and clean up its exclusively-owned process group."""
    deadline = time.monotonic() + timeout
    try:
        while not process_has_exited(process):
            if time.monotonic() >= deadline:
                terminate_process_group(process, timeout=cleanup_timeout)
                raise TimeoutError(f"{description} exceeded {timeout:g}s timeout")
            time.sleep(0.05)
    except BaseException:
        if process.returncode is None:
            terminate_process_group(process, timeout=cleanup_timeout)
        raise
    terminate_process_group(process, timeout=cleanup_timeout)
    return process.returncode if process.returncode is not None else 1


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def emulator_config(ports: dict[str, int]) -> dict[str, object]:
    return {
        "firestore": {
            "rules": str(ROOT / "firebase/firestore.rules"),
            "indexes": str(ROOT / "firebase/firestore.indexes.json"),
        },
        "database": {"rules": str(ROOT / "firebase/database.rules.json")},
        "storage": {"rules": str(ROOT / "firebase/storage.rules")},
        "emulators": {
            name: {"host": "127.0.0.1", "port": ports[name]}
            for name in ("auth", "firestore", "database", "storage")
        }
        | {
            "firestore": {
                "host": "127.0.0.1",
                "port": ports["firestore"],
                "websocketPort": ports["firestore_websocket"],
            },
            "hub": {"host": "127.0.0.1", "port": ports["hub"]},
            "logging": {"host": "127.0.0.1", "port": ports["logging"]},
            "ui": {"enabled": False},
            "singleProjectMode": True,
        },
    }


def run_emulators() -> int:
    ports = {
        name: free_loopback_port()
        for name in (
            "auth",
            "firestore",
            "firestore_websocket",
            "database",
            "storage",
            "hub",
            "logging",
            "api",
            "enforce_api",
            "web",
            "marionette",
        )
    }
    if len(set(ports.values())) != len(ports):
        raise RuntimeError("Could not allocate distinct loopback ports")

    with tempfile.TemporaryDirectory(prefix="issue-137-cors-") as private_dir:
        private = Path(private_dir)
        config_path = private / "firebase-emulators.json"
        config_path.write_text(
            json.dumps(emulator_config(ports)), encoding="utf-8"
        )
        firebase_bin = shlex.split(os.environ.get("FIREBASE_BIN", "firebase"))
        if not firebase_bin or shutil.which(firebase_bin[0]) is None:
            raise RuntimeError("Firebase CLI is unavailable; set FIREBASE_BIN")
        safe_paths = {
            key: os.environ[key]
            for key in ("FLUTTER_BIN", "FIREFOX_BIN")
            if os.environ.get(key)
        }
        child_env = isolated_environment(
            private / "firebase-home",
            extra={"CORS_TEST_PRIVATE_ROOT": str(private), **safe_paths},
            firebase_emulator_cache=True,
        )
        for name in ("auth", "firestore", "database", "storage"):
            child_env[f"FIREBASE_{name.upper()}_EMULATOR_HOST"] = f"127.0.0.1:{ports[name]}"
        child_env["FIREBASE_PROJECT_ID"] = PROJECT_ID
        inside = shlex.join(
            [sys.executable, str(Path(__file__).resolve()), "--inside", json.dumps(ports)]
        )
        command = [
            *firebase_bin,
            "emulators:exec",
            "--project",
            PROJECT_ID,
            "--config",
            str(config_path),
            "--only",
            "auth,firestore,database,storage",
            inside,
        ]
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=child_env,
            start_new_session=True,
        )
        return wait_with_cleanup(
            process,
            timeout=EMULATOR_RUN_TIMEOUT_SECONDS,
            description="Firebase Emulator run",
        )


def wait_http(url: str, process: subprocess.Popen[bytes], timeout: float = 120) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process_has_exited(process):
            raise RuntimeError(f"Child process exited before ready: {url}")
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except (OSError, urllib.error.URLError):
            time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for local service: {url}")


def terminate_owned(processes: list[subprocess.Popen[bytes]]) -> None:
    terminate_process_groups(list(reversed(processes)))


def assert_api_observed_preflight(log_path: Path) -> None:
    expected_path = "/v1/me/facility-memberships"
    with log_path.open(encoding="utf-8") as log:
        for line in log:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            request = entry.get("req")
            if (
                isinstance(request, dict)
                and request.get("method") == "OPTIONS"
                and request.get("url") == expected_path
            ):
                return
    raise AssertionError("API did not log the browser OPTIONS preflight")


def diagnostic_tail(path: Path, limit: int = 30) -> str:
    if not path.exists():
        return "<no process log>"
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-limit:]) or "<empty process log>"


class Marionette:
    """Small local Marionette client; no WebDriver daemon or extra package."""

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.next_id = 0
        hello = self._read()
        if not isinstance(hello, dict) or hello.get("applicationType") != "gecko":
            raise RuntimeError(
                f"Firefox sent an unexpected Marionette greeting: {hello!r}"
            )

    def _read(self) -> list[object]:
        size = bytearray()
        while not size.endswith(b":"):
            part = self.sock.recv(1)
            if not part:
                raise RuntimeError("Firefox Marionette socket closed")
            size.extend(part)
        remaining = int(size[:-1])
        payload = bytearray()
        while len(payload) < remaining:
            part = self.sock.recv(remaining - len(payload))
            if not part:
                raise RuntimeError("Firefox Marionette socket closed mid-message")
            payload.extend(part)
        return json.loads(payload)

    def command(self, name: str, parameters: dict[str, object] | None = None) -> object:
        self.next_id += 1
        payload = json.dumps([0, self.next_id, name, parameters or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        result = self._read()
        if len(result) != 4 or result[0] != 1 or result[1] != self.next_id:
            raise RuntimeError(f"Unexpected Marionette response for {name}")
        error = result[2]
        if error:
            raise RuntimeError(f"Firefox Marionette {name} failed: {error}")
        return result[3]


def execute_sync(
    driver: Marionette, script: str, args: list[object] | None = None
) -> object:
    result = driver.command(
        "WebDriver:ExecuteScript", {"script": script, "args": args or []}
    )
    if isinstance(result, dict) and "value" in result:
        return result["value"]
    return result


def execute_async(driver: Marionette, script: str, args: list[object]) -> object:
    result = driver.command(
        "WebDriver:ExecuteAsyncScript",
        {"script": script, "args": args, "sandbox": "default"},
    )
    if isinstance(result, dict) and "value" in result:
        return result["value"]
    return result


def wait_for_flutter_app(driver: Marionette) -> dict[str, object]:
    deadline = time.monotonic() + 90
    script = r"""
      return {
        title: document.title,
        flutterView: Boolean(document.querySelector(
          'flutter-view, flt-glass-pane, flt-semantics-host, flt-semantics'
        )),
        mainBundleLoaded: performance.getEntriesByType('resource').some(entry =>
          new URL(entry.name, location.href).pathname.endsWith('/main.dart.js')),
        loadedBootstrapAssets: performance.getEntriesByType('resource')
          .map(entry => new URL(entry.name, location.href).pathname.split('/').pop())
          .filter(name => /^(firebase|flutter)_bootstrap\.js$|^flutter\.js$|^main\.dart\.js$/.test(name)),
        startupFailure: document.body.textContent.includes(
          '起動に必要な接続を確認できません'
        ),
      };
    """
    current: object = {}
    while time.monotonic() < deadline:
        current = execute_sync(driver, script)
        if isinstance(current, dict):
            if current.get("flutterView") is True:
                return {**current, "started": True}
            if current.get("startupFailure") is True:
                return current
        time.sleep(0.25)
    return current if isinstance(current, dict) else {}


def run_browser(ports: dict[str, int]) -> None:
    processes: list[subprocess.Popen[bytes]] = []
    root = private_root()
    profile_dir = tempfile.TemporaryDirectory(
        prefix="firefox-profile-", dir=root
    )
    log_handles: list[object] = []
    marionette: Marionette | None = None
    flutter_log_path = root / "flutter.log"
    firefox_log_path = root / "firefox.log"
    try:
        # Preserve only executable/cache locations from the parent. Runtime
        # children below receive a fresh allowlisted environment.
        firebase_env = {
            key: os.environ[key]
            for key in ("FLUTTER_BIN", "FIREFOX_BIN")
            if os.environ.get(key)
        }
        emu_env = isolated_environment(root / "api-home")
        emu_env.update(
            {
                "FIREBASE_PROJECT_ID": PROJECT_ID,
                "FIREBASE_AUTH_EMULATOR_HOST": f"127.0.0.1:{ports['auth']}",
                "FIRESTORE_EMULATOR_HOST": f"127.0.0.1:{ports['firestore']}",
                "FIREBASE_DATABASE_EMULATOR_HOST": f"127.0.0.1:{ports['database']}",
                "FIREBASE_STORAGE_EMULATOR_HOST": f"127.0.0.1:{ports['storage']}",
                "SERVER_HMAC_SECRET": secrets.token_urlsafe(32),
                "HOST": "127.0.0.1",
                "PORT": str(ports["api"]),
                "API_CORS_ORIGINS": f"http://localhost:{ports['web']}",
                "APP_CHECK_MODE": "permissive",
                "LOG_LEVEL": "info",
            }
        )
        api_log_path = root / "api-info.jsonl"
        api_log = api_log_path.open("w", encoding="utf-8")
        log_handles.append(api_log)
        api = subprocess.Popen(
            ["node", "dist/index.js"],
            cwd=ROOT / "services/api",
            env=emu_env,
            stdout=api_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        processes.append(api)
        wait_http(f"http://127.0.0.1:{ports['api']}/health", api)
        print("Local API ready", flush=True)

        enforce_env = isolated_environment(root / "enforce-api-home") | {
            key: emu_env[key]
            for key in (
                "FIREBASE_PROJECT_ID",
                "FIREBASE_AUTH_EMULATOR_HOST",
                "FIRESTORE_EMULATOR_HOST",
                "FIREBASE_DATABASE_EMULATOR_HOST",
                "FIREBASE_STORAGE_EMULATOR_HOST",
                "SERVER_HMAC_SECRET",
                "HOST",
                "API_CORS_ORIGINS",
                "LOG_LEVEL",
            )
        } | {
            "PORT": str(ports["enforce_api"]),
            "APP_CHECK_MODE": "enforce",
        }
        enforce_api = subprocess.Popen(
            ["node", "dist/index.js"],
            cwd=ROOT / "services/api",
            env=enforce_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        processes.append(enforce_api)
        wait_http(f"http://127.0.0.1:{ports['enforce_api']}/health", enforce_api)
        print("Local API App Check control ready", flush=True)

        web_origin = f"http://localhost:{ports['web']}"
        dart_defines = {
            "USE_FIREBASE_EMULATOR": "true",
            "FIREBASE_PROJECT_ID": PROJECT_ID,
            "FIREBASE_EMULATOR_HOST": "127.0.0.1",
            "API_BASE_URL": f"http://127.0.0.1:{ports['api']}",
            "AUTH_EMULATOR_PORT": str(ports["auth"]),
            "FIRESTORE_EMULATOR_PORT": str(ports["firestore"]),
            "DATABASE_EMULATOR_PORT": str(ports["database"]),
            "STORAGE_EMULATOR_PORT": str(ports["storage"]),
        }
        flutter_command = [
            firebase_env.get("FLUTTER_BIN", "flutter"),
            "build",
            "web",
            "--release",
            "-t",
            "tool/browser_api_probe.dart",
            "--no-tree-shake-icons",
            *[f"--dart-define={key}={value}" for key, value in dart_defines.items()],
        ]
        flutter_bin = Path(flutter_command[0]).resolve()
        if flutter_bin.name == "flutter" and flutter_bin.parent.name == "bin":
            flutter_root = flutter_bin.parent.parent
        else:
            resolved_flutter = shutil.which(flutter_command[0])
            if resolved_flutter is None:
                raise RuntimeError("Flutter executable is unavailable")
            flutter_root = Path(resolved_flutter).resolve().parent.parent
        flutter_env = isolated_environment(
            root / "flutter-home",
            extra={
                "FLUTTER_ROOT": str(flutter_root),
                # Never inherit a developer's shared cache; pub may populate
                # this run-local cache only with normal hosted dependencies.
                "PUB_CACHE": str(root / "pub-cache"),
                "FLUTTER_SUPPRESS_ANALYTICS": "true",
                "DART_SUPPRESS_ANALYTICS": "true",
            },
        )
        flutter_log = flutter_log_path.open("w", encoding="utf-8")
        log_handles.append(flutter_log)
        flutter_build = subprocess.Popen(
            flutter_command,
            cwd=ROOT / "apps/patient",
            env=flutter_env,
            stdout=flutter_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        if wait_with_cleanup(
            flutter_build,
            timeout=300,
            description="Flutter probe build",
        ) != 0:
            raise RuntimeError("Flutter probe build failed")

        web_env = isolated_environment(root / "web-home")
        web_server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "http.server",
                str(ports["web"]),
                "--bind",
                "127.0.0.1",
                "--directory",
                str(ROOT / "apps/patient/build/web"),
            ],
            cwd=ROOT,
            env=web_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        processes.append(web_server)
        wait_http(f"http://127.0.0.1:{ports['web']}", web_server)
        print("Compiled Flutter Web build served", flush=True)

        firefox = shutil.which(firebase_env.get("FIREFOX_BIN", "firefox"))
        if firefox is None:
            raise RuntimeError("Firefox is required for the real-browser CORS test")
        xvfb = shutil.which("Xvfb")
        if xvfb is None:
            raise RuntimeError("Xvfb is required for software-rendered Firefox")
        xvfb_process = subprocess.Popen(
            [
                xvfb,
                "-displayfd",
                "1",
                "-screen",
                "0",
                "1280x1024x24",
                "-nolisten",
                "tcp",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        processes.append(xvfb_process)
        if xvfb_process.stdout is None or not select.select(
            [xvfb_process.stdout], [], [], 10
        )[0]:
            raise TimeoutError("Xvfb did not allocate a private display")
        display_number = xvfb_process.stdout.readline().decode().strip()
        if not display_number.isdigit():
            raise RuntimeError("Xvfb returned an invalid display number")
        # The packaged Firefox build used on the developer workstation ignores
        # MOZ_MARIONETTE_PORT. Set the preference in this disposable profile so
        # the automation socket also gets a per-run loopback port.
        Path(profile_dir.name, "user.js").write_text(
            f'user_pref("marionette.port", {ports["marionette"]});\n'
            'user_pref("marionette.enabled", true);\n'
            'user_pref("webgl.disabled", false);\n'
            'user_pref("webgl.force-enabled", true);\n'
            'user_pref("webgl.allow-software", true);\n'
            'user_pref("gfx.webrender.software", true);\n',
            encoding="utf-8",
        )
        firefox_env = isolated_environment(
            root / "firefox-home",
            extra={
                "DISPLAY": f":{display_number}",
                "MOZ_WEBRENDER": "software",
                "LIBGL_ALWAYS_SOFTWARE": "1",
            },
        )
        firefox_env["MOZ_MARIONETTE_PORT"] = str(ports["marionette"])
        firefox_log = firefox_log_path.open("w", encoding="utf-8")
        log_handles.append(firefox_log)
        firefox_process = subprocess.Popen(
            [
                firefox,
                "--no-remote",
                "--profile",
                profile_dir.name,
                "--marionette",
                "about:blank",
            ],
            env=firefox_env,
            stdout=firefox_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        processes.append(firefox_process)

        marionette_socket: socket.socket | None = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process_has_exited(firefox_process):
                raise RuntimeError("Firefox exited before Marionette was ready")
            try:
                marionette_socket = socket.create_connection(
                    ("127.0.0.1", ports["marionette"]), timeout=1
                )
                break
            except OSError:
                time.sleep(0.2)
        if marionette_socket is None:
            raise TimeoutError("Firefox Marionette did not become ready")
        marionette_socket.settimeout(45)
        marionette = Marionette(marionette_socket)
        print("Firefox Marionette connected", flush=True)
        marionette.command(
            "WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}}
        )
        print("Firefox WebDriver session ready", flush=True)
        marionette.command("WebDriver:SetTimeouts", {"script": 120000})

        # The Flutter/Dart probe itself signs in to Auth Emulator, obtains a
        # real ID token, and invokes PublicPatientApi from this browser origin.
        marionette.command("WebDriver:Navigate", {"url": web_origin})
        print("Flutter probe page navigated", flush=True)
        flutter_state = wait_for_flutter_app(marionette)
        print(f"Flutter runtime state: {flutter_state}", flush=True)
        result: object = ""
        result_deadline = time.monotonic() + 90
        while time.monotonic() < result_deadline:
            result = execute_sync(
                marionette,
                "return window.__browserApiProbeResult || '';",
            )
            if isinstance(result, str) and (
                result.startswith("API_RESULT:") or result.startswith("PROBE_FAILED:")
            ):
                break
            time.sleep(0.25)
        if result != "API_RESULT:0":
            raise AssertionError(f"Flutter Dart API client did not report expected response: {result!r}")
        auth_token = execute_sync(
            marionette, "return window.__browserApiProbeAuthToken || '';"
        )
        if not isinstance(auth_token, str) or not auth_token:
            raise AssertionError("Flutter probe did not expose its ephemeral emulator token")

        # Independent browser-enforced CORS checks. The API origin differs from
        # both page origins, so Firefox must issue real OPTIONS preflights.
        cors_url = f"http://127.0.0.1:{ports['api']}/v1/me/facility-memberships"
        cors_script = r"""
          const [url, token, done] = [arguments[0], arguments[1], arguments[arguments.length - 1]];
          return fetch(url, {
            method: 'GET', credentials: 'omit',
            headers: {'Authorization': `Bearer ${token}`, 'X-Request-Id': 'issue-137-cors'}
          }).then(async response => ({
            readable: true, status: response.status,
            body: await response.json()
          })).then(done).catch(error => done({readable: false, name: error.name}));
        """
        allowed = execute_async(marionette, cors_script, [cors_url, auth_token])
        if not isinstance(allowed, dict) or allowed.get("readable") is not True or allowed.get("status") != 200:
            raise AssertionError(f"Allowed-origin CORS response was not readable: {allowed!r}")
        if not isinstance(allowed.get("body"), dict) or allowed["body"].get("items") != []:
            raise AssertionError("Allowed-origin browser API response was unexpected")

        marionette.command("WebDriver:Navigate", {"url": f"http://127.0.0.1:{ports['web']}/"})
        denied = execute_async(marionette, cors_script, [cors_url, auth_token])
        if not isinstance(denied, dict) or denied.get("readable") is not False or denied.get("name") != "TypeError":
            raise AssertionError(f"Disallowed-origin CORS response was readable: {denied!r}")

        marionette.command("WebDriver:Navigate", {"url": web_origin})
        enforce_url = f"http://127.0.0.1:{ports['enforce_api']}/v1/me/facility-memberships"
        missing_app_check = execute_async(marionette, cors_script, [enforce_url, auth_token])
        if (
            not isinstance(missing_app_check, dict)
            or missing_app_check.get("readable") is not True
            or missing_app_check.get("status") != 401
            or not isinstance(missing_app_check.get("body"), dict)
            or missing_app_check["body"].get("error", {}).get("code") != "APP_CHECK_FAILED"
        ):
            raise AssertionError(f"Missing App Check was not explicitly rejected: {missing_app_check!r}")

        api_log.flush()
        assert_api_observed_preflight(api_log_path)

        print(
            "PASS: Firefox ran Flutter Dart PublicPatientApi against Auth Emulator; "
            "allowed CORS is readable, disallowed CORS is blocked, missing App Check "
            "returns APP_CHECK_FAILED, and API OPTIONS preflight was logged."
        )
        if flutter_state.get("started") is not True:
            flutter_log.flush()
            firefox_log.flush()
            raise AssertionError(
                "Flutter Web did not start: "
                f"main.dart.js loaded={flutter_state.get('mainBundleLoaded') is True}; "
                f"startup failure screen={flutter_state.get('startupFailure') is True}; "
                f"loaded bootstrap assets={flutter_state.get('loadedBootstrapAssets')}; "
                "no Flutter view or semantics DOM node\n"
                f"Flutter tool output:\n{diagnostic_tail(flutter_log_path)}\n"
                f"Firefox output:\n{diagnostic_tail(firefox_log_path)}"
            )
    except Exception as error:
        for handle in log_handles:
            handle.flush()
        raise RuntimeError(
            f"Flutter/browser stage failed: {error}\n"
            f"Flutter output:\n{diagnostic_tail(flutter_log_path)}\n"
            f"Firefox output:\n{diagnostic_tail(firefox_log_path)}"
        ) from error
    finally:
        if marionette is not None:
            try:
                marionette.command("WebDriver:DeleteSession")
            except (OSError, RuntimeError, TimeoutError):
                pass
            marionette.sock.close()
        terminate_owned(processes)
        for log_handle in log_handles:
            log_handle.close()
        profile_dir.cleanup()


def main() -> int:
    signal.signal(signal.SIGTERM, signal_to_cleanup)
    signal.signal(signal.SIGINT, signal_to_cleanup)
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        ports = json.loads(sys.argv[2])
        run_browser(ports)
        return 0

    flutter = os.environ.get("FLUTTER_BIN", "flutter")
    if shutil.which(flutter) is None:
        raise RuntimeError(f"Flutter SDK not found: {flutter}")
    if shutil.which("node") is None or shutil.which("npm") is None:
        raise RuntimeError("Node.js and npm are required")
    with tempfile.TemporaryDirectory(prefix="issue-137-api-build-") as build_dir:
        build_env = isolated_environment(Path(build_dir) / "home")
        build = subprocess.Popen(
            ["npm", "run", "build"],
            cwd=ROOT / "services/api",
            env=build_env,
            start_new_session=True,
        )
        if wait_with_cleanup(
            build,
            timeout=API_BUILD_TIMEOUT_SECONDS,
            description="API build",
        ) != 0:
            raise RuntimeError("Local API build failed")
    return run_emulators()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Keep errors useful without dumping tokens or response bodies.
        print(f"CORS browser test failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt as error:
        print(f"CORS browser test interrupted: {error}", file=sys.stderr)
        raise SystemExit(130)
