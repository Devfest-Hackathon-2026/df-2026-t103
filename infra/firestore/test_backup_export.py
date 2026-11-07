"""Exercise the shell entrypoint with a fake gcloud; never contact a service."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('backup-export.sh')
PROJECT = 'project-7efcc4c4-6c86-490c-ba5'
FAKE = '''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['FAKE_ROOT'])
with (root / 'calls').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
if os.environ.get('FAIL_STEP') and ' '.join(args).startswith(os.environ['FAIL_STEP']):
    sys.exit(3)
state = json.loads((root / 'state').read_text())
if args[:3] == ['firestore', 'databases', 'describe']:
    print(json.dumps(state['database']))
elif args[:4] == ['firestore', 'backups', 'schedules', 'list']:
    print(os.environ.get('SCHEDULE_RESPONSE', json.dumps(state['schedules'])))
elif args[:3] == ['firestore', 'databases', 'update']:
    if not os.environ.get('NO_UPDATE'):
        state['database']['pointInTimeRecoveryEnablement'] = 'POINT_IN_TIME_RECOVERY_ENABLED'
elif args[:4] == ['firestore', 'backups', 'schedules', 'create']:
    state['schedules'].append({'dailyRecurrence': {}, 'retention': '604800s'})
else:
    sys.exit(99)
(root / 'state').write_text(json.dumps(state))
'''


class BackupExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        tool = self.root / 'gcloud'
        tool.write_text(FAKE)
        tool.chmod(0o755)
        self.state = {
            'database': {'locationId': 'asia-northeast1',
                         'pointInTimeRecoveryEnablement': 'POINT_IN_TIME_RECOVERY_ENABLED'},
            'schedules': [{'dailyRecurrence': {}, 'retention': '604800s'}],
        }

    def run_script(self, *args, **extra):
        (self.root / 'state').write_text(json.dumps(self.state))
        env = {**os.environ, 'PATH': f'{self.root}:{os.environ["PATH"]}',
               'FAKE_ROOT': str(self.root), 'PROJECT_ID': PROJECT, **extra}
        # Keep developer environment overrides out of this test.
        for key in ('DATABASE', 'LOCATION'):
            if key not in extra:
                env.pop(key, None)
        result = subprocess.run(['bash', str(SCRIPT), *args], env=env,
                                text=True, capture_output=True)
        calls_path = self.root / 'calls'
        calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
        for call in calls:
            self.assertIn('--project', call)
            self.assertEqual(call[call.index('--project') + 1], PROJECT)
        return result, calls

    def assert_no_writes(self, calls):
        self.assertFalse(any('update' in call or 'create' in call for call in calls))

    def test_default_is_read_only(self):
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_writes(calls)

    def test_weekly_alone_does_not_satisfy_daily(self):
        self.state['schedules'] = [{'weeklyRecurrence': {'day': 'MONDAY'}, 'retention': '604800s'}]
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assert_no_writes(calls)

    def test_apply_creates_daily_alongside_weekly_and_verifies(self):
        self.state['schedules'] = [{'weeklyRecurrence': {'day': 'MONDAY'}, 'retention': '604800s'}]
        result, calls = self.run_script('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum('create' in c for c in calls), 1)
        self.assertEqual(sum('list' in c for c in calls), 2)
        self.assertFalse(any('delete' in c for c in calls))

    def test_failed_list_cannot_trigger_pitr_or_schedule_writes(self):
        self.state['database']['pointInTimeRecoveryEnablement'] = 'POINT_IN_TIME_RECOVERY_DISABLED'
        result, calls = self.run_script('--apply', FAIL_STEP='firestore backups schedules list')
        self.assertEqual(result.returncode, 3)
        self.assert_no_writes(calls)

    def test_failed_describe_stops_before_list(self):
        result, calls = self.run_script('--apply', FAIL_STEP='firestore databases describe')
        self.assertEqual(result.returncode, 3)
        self.assertEqual(len(calls), 1)

    def test_invalid_list_is_not_empty_list(self):
        for response in ('not-json', '{}', '[null]', '[{}]', '[{"dailyRecurrence":{},"weeklyRecurrence":{}}]'):
            with self.subTest(response=response):
                result, calls = self.run_script('--apply', SCHEDULE_RESPONSE=response)
                self.assertEqual(result.returncode, 2)
                self.assert_no_writes(calls)

    def test_retention_mismatch_and_duplicate_daily_refuse_writes(self):
        for schedules in ([{'dailyRecurrence': {}, 'retention': '1209600s'}],
                          self.state['schedules'] * 2):
            self.state['schedules'] = schedules
            result, calls = self.run_script('--apply')
            self.assertEqual(result.returncode, 2)
            self.assert_no_writes(calls)

    def test_wrong_location_or_unknown_pitr_refuse_writes(self):
        for field, value in (('locationId', 'us-central1'), ('pointInTimeRecoveryEnablement', 'UNKNOWN')):
            saved = self.state['database'].copy()
            self.state['database'][field] = value
            result, calls = self.run_script('--apply')
            self.assertEqual(result.returncode, 2)
            self.assert_no_writes(calls)
            self.state['database'] = saved

    def test_existing_policy_is_idempotent(self):
        result, calls = self.run_script('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_writes(calls)
        self.assertEqual(sum('list' in c for c in calls), 2)

    def test_pitr_enable_is_verified(self):
        self.state['database']['pointInTimeRecoveryEnablement'] = 'POINT_IN_TIME_RECOVERY_DISABLED'
        result, calls = self.run_script('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum('update' in c for c in calls), 1)

    def test_success_response_without_change_is_not_success(self):
        self.state['database']['pointInTimeRecoveryEnablement'] = 'POINT_IN_TIME_RECOVERY_DISABLED'
        result, _ = self.run_script('--apply', NO_UPDATE='1')
        self.assertEqual(result.returncode, 1)

    def test_wrong_scope_or_flags_stop_before_cloud_access(self):
        for args, env in ((['--apply'], {'PROJECT_ID': 'other-project'}),
                          (['--apply'], {'DATABASE': 'other'}),
                          (['--apply'], {'LOCATION': 'us-central1'}),
                          (['--unknown'], {}), (['--check', '--apply'], {})):
            result, calls = self.run_script(*args, **env)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
