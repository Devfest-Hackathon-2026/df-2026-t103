import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from summarize_flutter_machine import summarize


RECOVERY = "patient retries a committed answer with the same key and body"


def report(names=(RECOVERY,), *, recovery_result="success", recovery_hidden=False, recovery_skipped=False, suite_path="test/integration/public_patient_answer_recovery_test.dart", extra=(), all_skipped=False):
    events = [
        {"type": "start"},
        {"type": "suite", "suite": {"id": 0, "path": suite_path}},
        {"type": "testStart", "test": {"id": 1, "name": "loading /private/path", "suiteID": 0}},
        {"type": "allSuites", "count": 1},
        {"type": "testDone", "testID": 1, "result": "success", "skipped": False, "hidden": True},
    ]
    for index, name in enumerate(names, 2):
        events += [
            {"type": "testStart", "test": {"id": index, "name": name, "suiteID": 0}},
            {"type": "testDone", "testID": index, "result": recovery_result if name == RECOVERY else "success", "skipped": recovery_skipped if name == RECOVERY else all_skipped, "hidden": recovery_hidden if name == RECOVERY else False},
        ]
    events.extend(extra)
    if not any(isinstance(event, dict) and event.get("type") == "done" for event in extra):
        events.append({"type": "done", "success": True})
    return events


def machine_report(events):
    # Flutter --machine wraps flutter_tools event/params objects in a
    # one-element array, interleaved with the test package's type events.
    return [
        [{"event": "test.startedProcess", "params": {"vmServiceUri": None}}],
        *events,
    ]


class SummarizerTest(unittest.TestCase):
    def assert_rejected(self, events, required=True):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                summarize(path, required)

    def test_recovery_required_and_hidden_loading_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in machine_report(report())), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                summarize(path, True)
            self.assertIn("success=1 failure=0 skip=0", output.getvalue())
            self.assertIn("recovery=success", output.getvalue())

    def test_rejects_missing_failed_or_duplicate_recovery(self):
        self.assert_rejected(report(names=("unrelated",)))
        self.assert_rejected(report(recovery_result="failure"))
        self.assert_rejected(report(names=(RECOVERY, RECOVERY)))
        self.assert_rejected(report(recovery_hidden=True))
        self.assert_rejected(report(recovery_skipped=True))
        self.assert_rejected(report(suite_path="test/integration/another_test.dart"))

    def test_requires_visible_success_except_explicit_demo_define_skip(self):
        ordinary = report(names=("ordinary",), suite_path="test/integration/patient_intake_ui_test.dart", all_skipped=True)
        self.assert_rejected(ordinary, required=False)
        demo = report(names=("demo",), suite_path="test/integration/demo_email_registration_test.dart", all_skipped=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in demo), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                summarize(path, allow_all_skipped=True)
        normal_success = report(names=("ordinary",), suite_path="test/integration/patient_intake_ui_test.dart")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in normal_success), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                summarize(path)
        failed = report(names=("ordinary",), suite_path="test/integration/patient_intake_ui_test.dart")
        next(event for event in failed if event.get("type") == "testDone" and event.get("testID") == 2)["result"] = "failure"
        self.assert_rejected(failed, required=False)

    def test_requires_visible_success_for_ordinary_suite(self):
        self.assert_rejected(report(names=("ordinary",), suite_path="test/integration/patient_intake_ui_test.dart", all_skipped=True), required=False)

    def test_rejects_error_and_event_after_done(self):
        self.assert_rejected(report(extra=({"type": "error", "error": "redacted"},)))
        events = report()
        events.insert(-1, {"type": "done", "success": True})
        self.assert_rejected(events)

    def test_rejects_duplicate_or_missing_start(self):
        events = report()
        events.insert(1, {"type": "start"})
        self.assert_rejected(events)
        events = report()
        events.remove(events[0])
        self.assert_rejected(events)


if __name__ == "__main__":
    unittest.main()
