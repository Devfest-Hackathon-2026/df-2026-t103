import os
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

from run_browser_integration import (
    process_group_has_live_members,
    terminate_process_group,
    wait_with_cleanup,
)


class BoundedProcessTests(unittest.TestCase):
    def test_normal_leader_exit_still_cleans_term_ignoring_descendant(self) -> None:
        child_code = (
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "time.sleep(60)"
        )
        parent_code = (
            "import subprocess,sys; "
            f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
            "print(child.pid, flush=True)"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", parent_code],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        process_group = process.pid
        self.assertIsNotNone(process.stdout)
        child_pid = int(process.stdout.readline().strip())
        self.assertEqual(os.getpgid(child_pid), process_group)
        signals: list[int] = []
        original_killpg = os.killpg

        def record_killpg(pgid: int, sig: int) -> None:
            signals.append(sig)
            original_killpg(pgid, sig)

        try:
            with patch("run_browser_integration.os.killpg", side_effect=record_killpg):
                result = wait_with_cleanup(
                    process,
                    timeout=5,
                    description="normal-exit-test",
                    cleanup_timeout=0.15,
                )

            self.assertEqual(result, 0)
            self.assertIn(signal.SIGTERM, signals)
            self.assertIn(signal.SIGKILL, signals)
            self.assertFalse(process_group_has_live_members(process_group))
        finally:
            if process_group_has_live_members(process_group):
                try:
                    if os.getpgid(child_pid) == process_group:
                        os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if process.returncode is None:
                    terminate_process_group(process)
            if process.stdout is not None:
                process.stdout.close()

    def test_timeout_kills_term_ignoring_descendant_after_leader_exits(self) -> None:
        child_code = (
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "time.sleep(60)"
        )
        parent_code = (
            "import signal,subprocess,sys,time; "
            f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
            "print(child.pid, flush=True); time.sleep(60)"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", parent_code],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        process_group = process.pid
        self.assertIsNotNone(process.stdout)
        child_pid = int(process.stdout.readline().strip())
        self.assertEqual(os.getpgid(child_pid), process_group)
        signals: list[int] = []
        original_killpg = os.killpg

        def record_killpg(pgid: int, sig: int) -> None:
            signals.append(sig)
            original_killpg(pgid, sig)

        try:
            with patch("run_browser_integration.os.killpg", side_effect=record_killpg):
                with self.assertRaisesRegex(TimeoutError, "negative-test exceeded"):
                    wait_with_cleanup(
                        process,
                        timeout=0.05,
                        description="negative-test",
                        cleanup_timeout=0.15,
                    )

            self.assertIsNotNone(process.poll())
            self.assertIn(signal.SIGKILL, signals)
            self.assertFalse(process_group_has_live_members(process_group))
        finally:
            if process_group_has_live_members(process_group):
                try:
                    # The known descendant is a live anchor proving this PGID
                    # still belongs to this test even if the leader was reaped.
                    if os.getpgid(child_pid) == process_group:
                        os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if process.returncode is None:
                    terminate_process_group(process)
            if process.stdout is not None:
                process.stdout.close()

    def test_completed_child_returns_its_exit_status(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-c", "raise SystemExit(7)"],
            start_new_session=True,
        )

        self.assertEqual(
            wait_with_cleanup(process, timeout=5, description="exit-status test"), 7
        )


if __name__ == "__main__":
    unittest.main()
