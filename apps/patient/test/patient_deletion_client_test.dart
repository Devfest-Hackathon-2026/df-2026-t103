import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/patient_deletion_client.dart';
import 'package:patient/patient_intake_api.dart' show IntakeIdentity;

Map<String, dynamic> pending() => {
  'status': 'pending_deletion',
  'canCancel': true,
  'requestedAt': '2026-11-08T00:00:00Z',
  'cancelDeadline': '2026-12-08T00:00:00Z',
};

Map<String, dynamic> none() => {'status': 'none', 'canCancel': false};

PatientDeletionClient build(
  MockClient client, {
  IntakeIdentity? owner,
  bool Function(IntakeIdentity)? isCurrent,
}) {
  final id = owner ?? IntakeIdentity('patient-a', Object(), 'synthetic-token');
  return PatientDeletionClient(
    origin: 'http://127.0.0.1:8080',
    client: client,
    identity: () async => id,
    isCurrent: isCurrent ?? (_) => true,
  );
}

void main() {
  test('requesting deletion sends a fresh bearer + idempotency key and returns the status', () async {
    String? auth, key, method, path;
    final client = MockClient((request) async {
      auth = request.headers['authorization'];
      key = request.headers['idempotency-key'];
      method = request.method;
      path = request.url.path;
      return http.Response(
        jsonEncode(pending()),
        202,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    final result = await build(client).requestDeletion('idem-del-1');
    expect(result.status, 'pending_deletion');
    expect(result.canCancel, isTrue);
    expect(auth, 'Bearer synthetic-token');
    expect(key, 'idem-del-1');
    expect(method, 'POST');
    expect(path, '/v1/me/deletion-request');
  });

  test('a stale session is reported as reauth required (403), to drive re-auth', () async {
    final client = MockClient((_) async => http.Response('{"error":{}}', 403));
    await expectLater(
      build(client).requestDeletion('idem-del-2'),
      throwsA(
        isA<DeletionException>().having((e) => e.reason, 'reason', DeletionFailure.reauthRequired),
      ),
    );
  });

  test('throttling maps to rate limited', () async {
    final client = MockClient((_) async => http.Response('{}', 429));
    await expectLater(
      build(client).requestDeletion('idem-del-3'),
      throwsA(isA<DeletionException>().having((e) => e.reason, 'reason', DeletionFailure.rateLimited)),
    );
  });

  test('a conflicting request (already pending) maps to conflict', () async {
    final client = MockClient((_) async => http.Response('{}', 409));
    await expectLater(
      build(client).requestDeletion('idem-del-4'),
      throwsA(isA<DeletionException>().having((e) => e.reason, 'reason', DeletionFailure.conflict)),
    );
  });

  test('cancelling a pending request returns the restored status', () async {
    String? path, key;
    final client = MockClient((request) async {
      path = request.url.path;
      key = request.headers['idempotency-key'];
      return http.Response(
        jsonEncode(none()),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    final result = await build(client).cancelDeletion('idem-cancel-1');
    expect(result.status, 'none');
    expect(result.canCancel, isFalse);
    expect(path, '/v1/me/deletion-request/cancel');
    expect(key, 'idem-cancel-1');
  });

  test('cancelling with no pending request maps to not found (404)', () async {
    final client = MockClient((_) async => http.Response('{}', 404));
    await expectLater(
      build(client).cancelDeletion('idem-cancel-2'),
      throwsA(isA<DeletionException>().having((e) => e.reason, 'reason', DeletionFailure.notFound)),
    );
  });

  test('reading status issues a GET without an idempotency key', () async {
    String? method, key;
    final client = MockClient((request) async {
      method = request.method;
      key = request.headers['idempotency-key'];
      return http.Response(
        jsonEncode(pending()),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    final result = await build(client).status();
    expect(result.status, 'pending_deletion');
    expect(method, 'GET');
    expect(key, isNull);
  });

  test('a session change mid-request is surfaced, never applied to another user', () async {
    var current = true;
    final client = MockClient((_) async {
      current = false;
      return http.Response(jsonEncode(pending()), 202,
          headers: {'content-type': 'application/json; charset=utf-8'});
    });
    await expectLater(
      build(client, isCurrent: (_) => current).requestDeletion('idem-del-5'),
      throwsA(isA<DeletionException>().having((e) => e.reason, 'reason', DeletionFailure.sessionChanged)),
    );
  });

  test('a malformed or oversized body never counts as success', () async {
    for (final response in [
      http.Response('not json', 202, headers: {'content-type': 'application/json'}),
      http.Response('x' * (256 * 1024 + 1), 202, headers: {'content-type': 'application/json'}),
    ]) {
      final client = MockClient((_) async => response);
      await expectLater(
        build(client).requestDeletion('idem-del-6'),
        throwsA(isA<DeletionException>().having((e) => e.reason, 'reason', DeletionFailure.invalidResponse)),
      );
    }
  });

  test('production and lookalike origins are rejected before networking', () {
    final client = MockClient((_) async => throw StateError('must not send'));
    for (final origin in ['https://api.example.com', 'http://localhost.evil:8080']) {
      expect(
        () => PatientDeletionClient(
          origin: origin,
          client: client,
          identity: () async => throw StateError('no session'),
          isCurrent: (_) => false,
        ),
        throwsArgumentError,
      );
    }
  });
}
