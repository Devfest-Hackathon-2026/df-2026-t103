import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from summarize_flutter_machine import FLOW_MARKERS, diagnose_partial, run_partial_diagnostic, summarize


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

    def test_partial_diagnostic_contains_only_allowlisted_counts_and_completion(self):
        events = [
            {"type": "start"},
            {"type": "testStart", "test": {"name": "SECRET_NAME", "url": "SECRET_URL"}},
            {"type": "testDone", "result": "success", "skipped": False},
            {"type": "testDone", "result": "error", "skipped": True},
            {"type": "testDone", "result": "SECRET_RESULT", "skipped": False},
            {"type": "done", "success": True, "error": "SECRET_ERROR"},
            {"type": "unknown-secret-kind", "secret": "SECRET"},
            {"type": "print", "message": "edit-open-start"},
            {"type": "print", "message": "edit-open-tap-returned"},
            {"type": "print", "message": "edit-field-found"},
            {"type": "print", "message": "edit-input-returned"},
            {"type": "print", "message": "edit-save-start"},
            {"type": "print", "message": "edit-save-tap-returned"},
            *(
                {"type": "print", "message": marker}
                for marker in FLOW_MARKERS
                if marker.startswith("review-") or marker.startswith("hospital-")
            ),
            *({"type": "print", "message": marker} for marker in FLOW_MARKERS if marker.startswith("edit-after-") or "-check-" in marker),
            {"type": "print", "message": "edit-open SECRET_NAME"},
            {"type": "print", "message": "edit-field-found SECRET_URL"},
            {"type": "print", "message": "edit-after-get-completed SECRET_NAME"},
            {"type": "print", "message": "SECRET_NAME", "error": "SECRET_ERROR"},
            {"type": "print", "message": {"marker": "review"}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                diagnose_partial(path)
        diagnostic = output.getvalue()
        self.assertIn("testStart=1", diagnostic)
        self.assertIn("success=1 failure=0 error=0 skip=1", diagnostic)
        self.assertIn("reporter_done_success_seen=unknown", diagnostic)
        self.assertIn("edit-open-start=1", diagnostic)
        self.assertIn("edit-open-tap-returned=1", diagnostic)
        self.assertIn("edit-field-found=1", diagnostic)
        self.assertIn("edit-input-returned=1", diagnostic)
        self.assertIn("edit-save-start=1", diagnostic)
        self.assertIn("edit-save-tap-returned=1", diagnostic)
        for marker in FLOW_MARKERS:
            if marker.startswith("review-") or marker.startswith("hospital-") or marker.startswith("edit-after-") or "-check-" in marker:
                self.assertIn(f"{marker}=1", diagnostic)
        self.assertIn("review=0", diagnostic)
        for secret in ("SECRET_NAME", "SECRET_URL", "SECRET_ERROR", "SECRET_RESULT", "unknown-secret-kind", "edit-open SECRET_NAME", "edit-after-get-completed SECRET_NAME"):
            self.assertNotIn(secret, diagnostic)

    def test_partial_diagnostic_counts_only_exact_allowlisted_markers(self):
        events = [
            {"type": "print", "message": marker}
            for marker in FLOW_MARKERS
        ] + [
            {"type": "print", "message": "edit-after-get-completed-extra"},
            {"type": "print", "message": "SECRET_TOKEN"},
            {"type": "print", "message": "synthetic-ui-profile SECRET_PATIENT_INPUT"},
            {"type": "print", "message": "synthetic-ui-error-state SECRET_STACK"},
            {"type": "error", "error": "SECRET_CREDENTIAL", "stackTrace": "SECRET_STACK"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                diagnose_partial(path)
        diagnostic = output.getvalue()
        for marker in FLOW_MARKERS:
            self.assertIn(f"{marker}=1", diagnostic)
        self.assertIn("edit-after-get-completed=1", diagnostic)
        self.assertNotIn("edit-after-get-completed-extra", diagnostic)
        self.assertNotIn("SECRET_TOKEN", diagnostic)
        self.assertNotIn("SECRET_PATIENT_INPUT", diagnostic)
        self.assertNotIn("SECRET_STACK", diagnostic)
        self.assertNotIn("SECRET_CREDENTIAL", diagnostic)

    def test_partial_diagnostic_marks_truncated_output_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text('{"type":"start"}\n{"type":"done","success":false}\n', encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                diagnose_partial(path)
        self.assertIn("reporter_done_success_seen=unknown", output.getvalue())

    def test_partial_diagnostic_requires_valid_terminal_done(self):
        invalid_reports = (
            '{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":true}\nnot-json\n',
            '{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":true}\n{"type":"unknown"}\n',
            '{"type":"start"}\n{"type":"done","success":true}\n',
            '{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":true}\n{"type":"done","success":true}\n',
        )
        for contents in invalid_reports:
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "machine.jsonl"
                path.write_text(contents, encoding="utf-8")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    diagnose_partial(path)
                self.assertIn("reporter_done_success_seen=unknown", output.getvalue())
                self.assertNotIn("not-json", output.getvalue())

    def test_partial_diagnostic_reports_only_observed_done_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text(
                '{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":true}\n',
                encoding="utf-8",
            )
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                diagnose_partial(path)
        self.assertIn("reporter_done_success_seen=yes", output.getvalue())
        self.assertNotIn(" completed=", output.getvalue())
        self.assertIn("testStart=0", output.getvalue())
        self.assertIn("testDone=0", output.getvalue())

    def test_partial_diagnostic_distinguishes_absent_done_from_false_done(self):
        cases = (
            ('{"type":"start"}\n', "unknown"),
            ('{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":false}\n', "no"),
            ('{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":true}\n', "yes"),
        )
        for contents, expected in cases:
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "machine.jsonl"
                path.write_text(contents, encoding="utf-8")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    diagnose_partial(path)
                self.assertIn(f"reporter_done_success_seen={expected}", output.getvalue())

    def test_partial_diagnostic_marks_malformed_done_unknown_without_leaking_secret(self):
        for contents in (
            '{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":"SECRET"}\n',
            '{"type":"start"}\n{"type":"allSuites","count":1}\n{"type":"done","success":true}\n{"type":"print","message":"SECRET_AFTER_DONE"}\n',
        ):
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "machine.jsonl"
                path.write_text(contents, encoding="utf-8")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    diagnose_partial(path)
                self.assertIn("reporter_done_success_seen=unknown", output.getvalue())
                self.assertNotIn("SECRET", output.getvalue())

    def test_partial_diagnostic_ignores_unhashable_event_values(self):
        events = [
            {"type": ["not", "hashable"]},
            [{"event": {"also": "not hashable"}}],
            {"type": "testDone", "result": {"bad": "result"}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "machine.jsonl"
            path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                diagnose_partial(path)
        self.assertIn("diagnostic reporter_done_success_seen=unknown", output.getvalue())
        self.assertNotIn("not hashable", output.getvalue())

    def test_diagnostic_exception_is_replaced_with_fixed_message(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            with patch("summarize_flutter_machine.diagnose_partial", side_effect=TypeError("SECRET")):
                run_partial_diagnostic("unused")
        self.assertEqual(output.getvalue(), "partial Flutter diagnostics unavailable\n")

    def test_runner_diagnostic_does_not_replace_flutter_exit_status(self):
        script = Path(__file__).with_name("summarize_flutter_machine.py")
        runner = (
            "set -e; status=37; "
            f"python3 {str(script)!r} /no/such/machine.jsonl --diagnostic-partial; "
            "exit \"$status\""
        )
        result = subprocess.run(["bash", "-c", runner], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 37)
        self.assertEqual(result.stderr, "")
        self.assertIn("diagnostic reporter_done_success_seen=unknown", result.stdout)


if __name__ == "__main__":
    unittest.main()
