"""Read backup metadata only; never restore, export, or inspect documents."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import re
import subprocess
import sys

PROJECT = 'project-7efcc4c4-6c86-490c-ba5'
LOCATION = 'asia-northeast1'
DATABASE = f'projects/{PROJECT}/databases/(default)'
BACKUP_PREFIX = f'projects/{PROJECT}/locations/{LOCATION}/backups/'
RPO = timedelta(hours=24)


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})', value
    ):
        raise ValueError('Invalid timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def assess(database, backups, now):
    """A current usable snapshot is evidence of freshness, not restore success."""
    if (not isinstance(database, dict) or database.get('name') != DATABASE
            or database.get('locationId') != LOCATION
            or not isinstance(database.get('uid'), str) or not database['uid']
            or not isinstance(backups, list)):
        raise ValueError('Invalid metadata')
    snapshots = []
    for backup in backups:
        if not isinstance(backup, dict) or not isinstance(backup.get('database'), str):
            raise ValueError('Invalid backup')
        if backup['database'] != DATABASE:
            continue
        # A database recreated under the same ID must not use its predecessor's backups.
        if not isinstance(backup.get('databaseUid'), str) or not backup['databaseUid']:
            raise ValueError('Missing database incarnation')
        if backup['databaseUid'] != database['uid']:
            continue
        name = backup.get('name')
        if (not isinstance(name, str) or not name.startswith(BACKUP_PREFIX)
                or not name[len(BACKUP_PREFIX):] or '/' in name[len(BACKUP_PREFIX):]
                or backup.get('state') not in ('STATE_UNSPECIFIED', 'CREATING', 'READY', 'NOT_AVAILABLE')):
            raise ValueError('Invalid backup scope or state')
        if backup['state'] != 'READY':
            continue
        snapshot = timestamp(backup.get('snapshotTime'))
        expiry = timestamp(backup.get('expireTime'))
        if snapshot > now or expiry <= snapshot:
            raise ValueError('Invalid backup time')
        if expiry > now:
            snapshots.append(snapshot)
    result = {'checkedAt': now.isoformat(), 'rpoTargetHours': 24}
    if not snapshots:
        return 1, {**result, 'status': 'no_usable_backup'}
    latest = max(snapshots)
    age = now - latest
    fresh = age <= RPO
    return (0 if fresh else 1), {
        **result, 'status': 'fresh' if fresh else 'stale',
        'latestSnapshotTime': latest.isoformat(), 'ageSeconds': math.ceil(age.total_seconds()),
    }


def read_metadata(args):
    result = subprocess.run(['gcloud', *args, '--project', PROJECT, '--format=json'],
                            capture_output=True, text=True, check=True, timeout=60)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, choices=[PROJECT])
    parser.parse_args()
    try:
        database = read_metadata(['firestore', 'databases', 'describe', '--database', '(default)'])
        # No --limit: gcloud must retrieve all pages, including older successful snapshots.
        backups = read_metadata(['firestore', 'backups', 'list', '--location', LOCATION])
        code, result = assess(database, backups, datetime.now(timezone.utc))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        code, result = 3, {'status': 'metadata_read_failed'}
    except (ValueError, TypeError, OverflowError):
        code, result = 2, {'status': 'invalid_metadata'}
    # Never echo raw responses, resource identifiers, gcloud stderr, or exception contents.
    print(json.dumps(result))
    return code


if __name__ == '__main__':
    sys.exit(main())
