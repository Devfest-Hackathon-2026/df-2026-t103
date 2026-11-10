"""Offline DR clock boundaries, incomplete evidence and CLI redaction."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import unittest

import dr_timing as checker

INCIDENT = datetime(2026, 11, 9, tzinfo=timezone.utc)


def utc(value):
    return value.isoformat().replace('+00:00', 'Z')


def record(rpo=timedelta(hours=24), rto=timedelta(hours=8)):
    return {
        'snapshotTime': utc(INCIDENT - rpo), 'incidentTime': utc(INCIDENT),
        'restoreCompletedAt': utc(INCIDENT + timedelta(hours=1)),
        'deletionReappliedAt': utc(INCIDENT + timedelta(hours=2)),
        'validationCompletedAt': utc(INCIDENT + timedelta(hours=3)),
        'serviceResumedAt': utc(INCIDENT + rto),
    }


class TimingTests(unittest.TestCase):
    def test_inclusive_targets(self):
        code, result = checker.assess(record())
        self.assertEqual(code, 0)
        self.assertEqual(result['rpoSeconds'], 86400)
        self.assertEqual(result['rtoSeconds'], 28800)
        self.assertTrue(result['rpoMet'])
        self.assertTrue(result['rtoMet'])

    def test_one_microsecond_over_either_target_fails(self):
        for rpo, rto, failed in (
            (timedelta(hours=24, microseconds=1), timedelta(hours=8), 'rpoMet'),
            (timedelta(hours=24), timedelta(hours=8, microseconds=1), 'rtoMet'),
            (timedelta(hours=25), timedelta(hours=9), 'rpoMet'),
        ):
            with self.subTest(failed=failed):
                code, result = checker.assess(record(rpo, rto))
                self.assertEqual(code, 1)
                self.assertFalse(result[failed])

    def test_rto_includes_post_restore_deletion_validation_and_reopening(self):
        # Restore completes in one hour, but service reopening exceeds eight hours.
        code, result = checker.assess(record(rto=timedelta(hours=9)))
        self.assertEqual(code, 1)
        self.assertEqual(result['rtoSeconds'], 32400)
        self.assertTrue(result['rpoMet'])
        self.assertFalse(result['rtoMet'])

    def test_every_stage_required(self):
        for field in checker.FIELDS:
            incomplete = record()
            del incomplete[field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                checker.assess(incomplete)

    def test_each_reversed_stage_rejected(self):
        for index in range(1, len(checker.FIELDS)):
            invalid = record()
            earlier = checker.timestamp(invalid[checker.FIELDS[index - 1]])
            invalid[checker.FIELDS[index]] = utc(earlier - timedelta(microseconds=1))
            with self.subTest(index=index), self.assertRaises(ValueError):
                checker.assess(invalid)

    def test_equal_stage_times_allowed(self):
        code, result = checker.assess({field: utc(INCIDENT) for field in checker.FIELDS})
        self.assertEqual(code, 0)
        self.assertEqual(result['rtoSeconds'], 0)

    def test_malformed_or_ambiguous_timestamps_rejected(self):
        for value in (None, 12, True, '', '2026-11-09', '2026-11-09T00:00:00',
                      '2026-02-30T00:00:00Z', '2026-11-09T00:00:00+09:00',
                      '2026-11-09T00:00:00.1234567Z', '2026-11-09T24:00:00Z'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                checker.assess({**record(), 'incidentTime': value})

    def test_unknown_fields_and_non_objects_rejected(self):
        for invalid in (None, [], 'text', {**record(), 'patientUid': 'PRIVATE_MARKER'}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                checker.assess(invalid)


class CommandTests(unittest.TestCase):
    def run_cli(self, content):
        return subprocess.run([sys.executable, str(Path(checker.__file__))], input=content,
                              text=True, capture_output=True, timeout=10)

    def test_cli_exit_codes(self):
        for source, expected in ((record(), 0), (record(rto=timedelta(hours=9)), 1)):
            result = self.run_cli(json.dumps(source))
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertEqual(result.stderr, '')
            self.assertNotIn('snapshotTime', result.stdout)

    def test_invalid_input_is_sanitized(self):
        for source in ('PRIVATE_MARKER', '', 'null', '[]',
                       json.dumps({**record(), 'patientUid': 'PRIVATE_MARKER'}),
                       json.dumps({**record(), 'incidentTime': 'PRIVATE_MARKER'}),
                       json.dumps(record())[:-1] + ',"incidentTime":"PRIVATE_MARKER"}'):
            result = self.run_cli(source)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout), {'status': 'invalid_timing_record'})
            self.assertEqual(result.stderr, '')
            self.assertNotIn('PRIVATE_MARKER', result.stdout)


if __name__ == '__main__':
    unittest.main()
