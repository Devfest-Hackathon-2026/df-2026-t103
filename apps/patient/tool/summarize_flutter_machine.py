#!/usr/bin/env python3
"""Validate Flutter test JSON reporter output without exposing test details."""

import json
import sys
from collections import defaultdict

RECOVERY = "patient retries a committed answer with the same key and body"
RECOVERY_SUITE = "test/integration/public_patient_answer_recovery_test.dart"
DEMO_SKIP_SUITE = "test/integration/demo_email_registration_test.dart"
FLUTTER_EVENTS = {"test.startedProcess"}
DIAGNOSTIC_EVENTS = ("start", "suite", "testStart", "testDone", "allSuites", "done", "error", "group", "print", "debug", "test.startedProcess")
DIAGNOSTIC_RESULTS = ("success", "failure", "error", "skip")


def diagnose_partial(path):
    """Print only allowlisted event/result counts; never echo event contents."""
    events = defaultdict(int)
    results = defaultdict(int)
    completed = False
    try:
        with open(path, encoding="utf-8") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, UnicodeError):
                    continue
                if isinstance(event, list) and len(event) == 1 and isinstance(event[0], dict):
                    kind = event[0].get("event")
                    if isinstance(kind, str) and kind in FLUTTER_EVENTS:
                        events[kind] += 1
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("type")
                if not isinstance(kind, str) or kind not in DIAGNOSTIC_EVENTS:
                    continue
                events[kind] += 1
                if kind == "testDone":
                    result = event.get("result")
                    if result in ("success", "failure", "error"):
                        result = "skip" if event.get("skipped") is True else result
                        results[result] += 1
                if kind == "done" and event.get("success") is True:
                    completed = True
    except (OSError, UnicodeError):
        pass
    print("diagnostic events " + " ".join(f"{kind}={events[kind]}" for kind in DIAGNOSTIC_EVENTS))
    print("diagnostic results " + " ".join(f"{result}={results[result]}" for result in DIAGNOSTIC_RESULTS))
    print(f"diagnostic completed={'yes' if completed else 'no'}")


def run_partial_diagnostic(path):
    """Keep diagnostic failures silent and success-shaped for the caller."""
    try:
        diagnose_partial(path)
    except Exception:
        # Do not expose parser errors or untrusted event values in CI logs.
        print("partial Flutter diagnostics unavailable")


def summarize(path, require_recovery=False, allow_all_skipped=False):
    counts = defaultdict(lambda: {"success": 0, "failure": 0, "skip": 0})
    started = {}
    finished = set()
    results = {}
    test_details = {}
    suite_paths = {}
    done = None
    all_suites = None
    saw_start = False
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except (json.JSONDecodeError, UnicodeError):
                raise ValueError("invalid reporter event") from None
            if done is not None:
                raise ValueError("event after done")
            if isinstance(event, list):
                # Flutter --machine wraps flutter_tools events (for example
                # test.startedProcess) in a one-element array. The test
                # package's type-tagged reporter events are standalone objects.
                if len(event) != 1 or not isinstance(event[0], dict):
                    raise ValueError("invalid Flutter event")
                flutter_event = event[0]
                if set(flutter_event) != {"event", "params"} or flutter_event.get("event") not in FLUTTER_EVENTS:
                    raise ValueError("unknown Flutter event")
                params = flutter_event["params"]
                if not isinstance(params, dict) or set(params) != {"vmServiceUri"} or (
                    params["vmServiceUri"] is not None and not isinstance(params["vmServiceUri"], str)
                ):
                    raise ValueError("invalid Flutter event params")
                continue
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                raise ValueError("invalid reporter event")
            kind = event["type"]
            if not saw_start and kind != "start":
                raise ValueError("reporter event before start")
            if kind == "suite":
                suite = event.get("suite")
                if not isinstance(suite, dict) or type(suite.get("id")) is not int or not isinstance(suite.get("path"), str):
                    raise ValueError("invalid suite event")
                if suite["id"] in suite_paths:
                    raise ValueError("duplicate suite")
                suite_paths[suite["id"]] = suite["path"]
            elif kind == "testStart":
                if not saw_start:
                    raise ValueError("test event before start")
                test = event.get("test")
                if not isinstance(test, dict) or type(test.get("id")) is not int or not isinstance(test.get("name"), str) or type(test.get("suiteID")) is not int:
                    raise ValueError("invalid testStart event")
                if test["id"] in started:
                    raise ValueError("duplicate test start")
                if test["suiteID"] not in suite_paths:
                    raise ValueError("unknown test suite")
                started[test["id"]] = (test["suiteID"], test["name"])
            elif kind == "testDone":
                if not saw_start:
                    raise ValueError("test event before start")
                test_id = event.get("testID")
                if type(test_id) is not int or test_id not in started or test_id in finished:
                    raise ValueError("invalid testDone event")
                if event.get("result") not in ("success", "failure", "error") or type(event.get("skipped")) is not bool or type(event.get("hidden", False)) is not bool:
                    raise ValueError("invalid test result")
                if event["skipped"]:
                    result = "skip"
                elif event["result"] == "success":
                    result = "success"
                else:
                    result = "failure"
                suite_id, name = started[test_id]
                if not event.get("hidden", False):
                    counts[suite_id][result] += 1
                results[test_id] = result
                test_details[test_id] = (event.get("hidden", False), event["skipped"])
                finished.add(test_id)
            elif kind == "allSuites":
                if all_suites is not None or type(event.get("count")) is not int or event["count"] < 1:
                    raise ValueError("invalid allSuites event")
                all_suites = event["count"]
            elif kind == "done":
                if not saw_start or event.get("success") is not True:
                    raise ValueError("invalid done event")
                done = True
            elif kind == "start":
                if saw_start:
                    raise ValueError("duplicate start")
                saw_start = True
            elif kind == "error":
                raise ValueError("reporter error event")
            elif kind in {"group", "print", "debug"}:
                continue
            else:
                raise ValueError("unknown reporter event")
    if not saw_start or done is not True or all_suites is None or not started or finished != set(started):
        raise ValueError("incomplete reporter summary")
    if all_suites != len(suite_paths):
        raise ValueError("suite count mismatch")
    expected_suite = RECOVERY_SUITE if require_recovery else None
    if allow_all_skipped and require_recovery:
        raise ValueError("invalid suite policy")
    if len(suite_paths) != 1:
        raise ValueError("expected exactly one integration suite")
    suite_path = next(iter(suite_paths.values()))
    if expected_suite is not None and not suite_path.endswith(expected_suite):
        raise ValueError("unexpected required suite")
    if allow_all_skipped and not suite_path.endswith(DEMO_SKIP_SUITE):
        raise ValueError("all-skipped allowance is limited to demo suite")
    suite_count = counts[next(iter(suite_paths))]
    if suite_count["failure"]:
        raise ValueError("integration tests failed")
    if suite_count["success"] == 0 and not allow_all_skipped:
        raise ValueError("integration suite has no visible successful test")
    recovery_named = [test_id for test_id, (_, name) in started.items() if name == RECOVERY]
    recovery = [test_id for test_id in recovery_named
                if suite_paths[started[test_id][0]].endswith(RECOVERY_SUITE)]
    if require_recovery and (len(recovery_named) != 1 or len(recovery) != 1 or results.get(recovery[0]) != "success"
                             or test_details[recovery[0]] != (False, False)):
        raise ValueError("recovery test did not succeed")
    if not require_recovery and recovery_named:
        raise ValueError("unexpected recovery test outside required suite")
    for suite_id, path in sorted(suite_paths.items()):
        count = counts[suite_id]
        print(f"file={path.rsplit('/', 1)[-1]} success={count['success']} failure={count['failure']} skip={count['skip']}")
    if require_recovery:
        print("recovery=success")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[2] == "--diagnostic-partial":
            run_partial_diagnostic(sys.argv[1])
            raise SystemExit(0)
        if len(sys.argv) > 3 or (len(sys.argv) == 3 and sys.argv[2] not in ("--require-recovery", "--allow-all-skipped")):
            raise ValueError("invalid invocation")
        summarize(sys.argv[1], "--require-recovery" in sys.argv[2:], "--allow-all-skipped" in sys.argv[2:])
    except (OSError, ValueError):
        print("Flutter machine report rejected", file=sys.stderr)
        raise SystemExit(1)
