"""Freshness and CLI failure tests; the fake gcloud never contacts Google."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import backup_freshness as checker

NOW = datetime(2026, 11, 9, 0, 0, tzinfo=timezone.utc)
DATABASE = {'name': checker.DATABASE, 'uid': 'current-instance', 'locationId': checker.LOCATION}


def backup(age=timedelta(hours=1), **overrides):
    return {
        'name': checker.BACKUP_PREFIX + 'synthetic-backup',
        'database': checker.DATABASE, 'databaseUid': DATABASE['uid'], 'state': 'READY',
        'snapshotTime': (NOW - age).isoformat(), 'expireTime': (NOW + timedelta(days=6)).isoformat(),
        **overrides,
    }


class FreshnessTests(unittest.TestCase):
    def test_inclusive_24_hour_boundary(self):
        for age, expected in ((timedelta(hours=24), 0),
                              (timedelta(hours=24, microseconds=1), 1)):
            with self.subTest(age=age):
                code, result = checker.assess(DATABASE, [backup(age)], NOW)
                self.assertEqual(code, expected)
                self.assertEqual(result['status'], 'fresh' if expected == 0 else 'stale')

    def test_newest_usable_snapshot_is_selected_without_order_assumptions(self):
        rows = [backup(timedelta(hours=25)), backup(), backup(timedelta(hours=2))]
        for order in (rows, list(reversed(rows))):
            code, result = checker.assess(DATABASE, order, NOW)
            self.assertEqual(code, 0)
            self.assertEqual(result['ageSeconds'], 3600)

    def test_in_progress_unavailable_expired_and_other_incarnations_cannot_satisfy_rpo(self):
        for rows in ([], [backup(state='CREATING')], [backup(state='NOT_AVAILABLE')],
                     [backup(state='STATE_UNSPECIFIED')], [backup(expireTime=NOW.isoformat())],
                     [backup(databaseUid='deleted-instance')],
                     [backup(database='projects/other/databases/(default)')]):
            with self.subTest(rows=rows):
                self.assertEqual(checker.assess(DATABASE, rows, NOW)[1]['status'], 'no_usable_backup')

    def test_failed_new_backup_does_not_mask_stale_ready_backup(self):
        code, result = checker.assess(DATABASE, [backup(state='CREATING'), backup(timedelta(hours=25))], NOW)
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'stale')

    def test_unknown_or_malformed_metadata_fails_closed(self):
        for rows in ({}, [None], [{}], [backup(state='NEW_UNKNOWN_STATE')],
                     [backup(databaseUid=None)], [backup(name='projects/other/backups/id')],
                     [backup(name=checker.BACKUP_PREFIX)],
                     [backup(name=checker.BACKUP_PREFIX + 'id/extra')],
                     [backup(snapshotTime=None)], [backup(expireTime='not-a-date')],
                     [backup(snapshotTime='2026-11-08')],
                     [backup(snapshotTime='2026-11-08T00:00:00')],
                     [backup(snapshotTime='2026-02-30T00:00:00Z')],
                     [backup(timedelta(seconds=-1))],
                     [backup(expireTime=(NOW - timedelta(hours=2)).isoformat())]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                checker.assess(DATABASE, rows, NOW)

    def test_wrong_database_metadata_is_rejected(self):
        for changes in ({'name': 'other'}, {'uid': ''}, {'uid': None}, {'locationId': 'us-central1'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                checker.assess({**DATABASE, **changes}, [backup()], NOW)

    def test_rfc3339_offset_and_nanosecond_timestamps(self):
        code, result = checker.assess(DATABASE, [backup(snapshotTime='2026-11-08T23:00:00.123456789Z')], NOW)
        self.assertEqual(code, 0)
        self.assertEqual(result['ageSeconds'], 3600)
        self.assertEqual(checker.timestamp('2026-11-09T08:00:00+09:00'), NOW - timedelta(hours=1))


class CommandTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        tool = self.root / 'gcloud'
        tool.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FAKE_ROOT'])
with (root / 'calls').open('a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('FAIL'):
    print('PRIVATE_MARKER', file=sys.stderr)
    sys.exit(7)
if sys.argv[1:4] == ['firestore', 'databases', 'describe']:
    print((root / 'database').read_text())
elif sys.argv[1:4] == ['firestore', 'backups', 'list']:
    print((root / 'backups').read_text())
else:
    sys.exit(99)
''')
        tool.chmod(0o755)
        (self.root / 'database').write_text(json.dumps(DATABASE))
        now = datetime.now(timezone.utc)
        row = backup(snapshotTime=(now - timedelta(hours=1)).isoformat(),
                     expireTime=(now + timedelta(days=1)).isoformat())
        (self.root / 'backups').write_text(json.dumps([row]))

    def run_cli(self, project=checker.PROJECT, **extra):
        env = {**os.environ, 'PATH': f'{self.root}:{os.environ["PATH"]}',
               'FAKE_ROOT': str(self.root), **extra}
        result = subprocess.run(['python3', str(Path(checker.__file__)), '--project', project],
                                env=env, capture_output=True, text=True)
        calls_path = self.root / 'calls'
        calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
        return result, calls

    def test_command_reads_current_database_and_all_backup_pages_only(self):
        result, calls = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'fresh')
        self.assertEqual(calls, [
            ['firestore', 'databases', 'describe', '--database', '(default)', '--project', checker.PROJECT, '--format=json'],
            ['firestore', 'backups', 'list', '--location', checker.LOCATION, '--project', checker.PROJECT, '--format=json'],
        ])
        self.assertNotIn(DATABASE['uid'], result.stdout)
        self.assertNotIn(checker.DATABASE, result.stdout)

    def test_wrong_project_stops_before_cloud_access(self):
        result, calls = self.run_cli(project='other')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])

    def test_cloud_failure_is_not_empty_or_fresh_and_does_not_echo_stderr(self):
        result, calls = self.run_cli(FAIL='1')
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)['status'], 'metadata_read_failed')
        self.assertNotIn('PRIVATE_MARKER', result.stdout + result.stderr)
        self.assertEqual(len(calls), 1)

    def test_invalid_json_is_not_empty_or_fresh(self):
        (self.root / 'backups').write_text('PRIVATE_MARKER')
        result, _ = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['status'], 'invalid_metadata')
        self.assertNotIn('PRIVATE_MARKER', result.stdout + result.stderr)

    def test_no_ready_backup_is_an_actionable_failure(self):
        (self.root / 'backups').write_text('[]')
        result, _ = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['status'], 'no_usable_backup')


if __name__ == '__main__':
    unittest.main()
