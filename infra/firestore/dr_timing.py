"""Evaluate recorded DR timings offline; never connect to or modify a database."""
import argparse
from datetime import datetime, timedelta
import json
import math
import re
import sys

FIELDS = (
    'snapshotTime', 'incidentTime', 'restoreCompletedAt',
    'deletionReappliedAt', 'validationCompletedAt', 'serviceResumedAt',
)
RPO = timedelta(hours=24)
RTO = timedelta(hours=8)


def timestamp(value):
    # Reject sub-microsecond input rather than silently rounding a target boundary.
    if not isinstance(value, str) or not re.fullmatch(
        r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value
    ):
        raise ValueError('Expected UTC timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def assess(record):
    """Timing targets alone do not attest restore correctness or authorize reopening."""
    if not isinstance(record, dict) or set(record) != set(FIELDS):
        raise ValueError('Expected all timing fields only')
    times = [timestamp(record[field]) for field in FIELDS]
    if any(earlier > later for earlier, later in zip(times, times[1:])):
        raise ValueError('Stages out of order')
    rpo = times[1] - times[0]
    rto = times[-1] - times[1]
    met = rpo <= RPO and rto <= RTO
    return (0 if met else 1), {
        'status': 'timing_targets_met' if met else 'timing_targets_exceeded',
        'rpoSeconds': math.ceil(rpo.total_seconds()),
        'rtoSeconds': math.ceil(rto.total_seconds()),
        'rpoTargetSeconds': int(RPO.total_seconds()),
        'rtoTargetSeconds': int(RTO.total_seconds()),
        'rpoMet': rpo <= RPO,
        'rtoMet': rto <= RTO,
    }


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate field')
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        record = json.load(sys.stdin, object_pairs_hook=unique_object)
        code, result = assess(record)
    except (ValueError, TypeError, OverflowError, OSError):
        # Never echo input, unknown fields, identifiers, or exception messages.
        code, result = 2, {'status': 'invalid_timing_record'}
    print(json.dumps(result))
    return code


if __name__ == '__main__':
    sys.exit(main())
