import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/patient_intake_api.dart';

Map<String, dynamic> readyMe() => {
  'uid': 'patient-a',
  'accountStatus': 'active',
  'onboardingState': 'completed',
  'emailVerified': true,
  'requiredConsents': {'current': true, 'missing': <String>[]},
  'profileComplete': true,
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

void main() {
  for (final stage in ['none', 'create', 'symptoms']) {
    test(
      'save and recover an uncertain $stage response without duplication',
      () async {
        final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
        var created = 0, writes = 0, failed = false;
        String? key, text;
        final client = MockClient((request) async {
          expect(request.headers['authorization'], 'Bearer synthetic-token');
          final path = request.url.path;
          if (path == '/v1/me') {
            return http.Response(jsonEncode(readyMe()), 200);
          }
          if (path == '/v1/intakes') {
            key ??= request.headers['idempotency-key'];
            expect(request.headers['idempotency-key'], key);
            if (created == 0) {
              created++;
            }
            if (stage == 'create' && !failed) {
              failed = true;
              throw Exception('synthetic lost response');
            }
            return http.Response(
              jsonEncode({
                'intakeId': 'test-intake',
                'status': 'draft',
                'revision': 1,
              }),
              201,
            );
          }
          if (path.endsWith('/symptoms')) {
            final body = jsonDecode(request.body) as Map;
            expect(body['expectedIntakeRevision'], 1);
            text = body['initialSymptomText'] as String;
            writes++;
            if (stage == 'symptoms' && !failed) {
              failed = true;
              throw Exception('synthetic lost response');
            }
          }
          return http.Response(
            jsonEncode({
              'intakeId': 'test-intake',
              'status': text == null ? 'draft' : 'questioning',
              'revision': text == null ? 1 : 2,
              'initialSymptomText': text,
            }),
            200,
          );
        });
        addTearDown(client.close);
        final api = PatientIntakeApi(
          origin: 'http://127.0.0.1:8080',
          client: client,
          identity: () async => owner,
          isCurrent: (_) => true,
        );
        final attempt = IntakeSubmission('  合成の症状入力  ');
        if (stage != 'none') {
          await expectLater(
            api.submit(attempt),
            throwsA(isA<IntakeApiException>()),
          );
        }
        await api.submit(attempt);
        await api.submit(attempt);
        expect(created, 1);
        expect(writes, 1);
        expect(text, '合成の症状入力');
      },
    );
  }

  test('expired consent prevents creating an intake', () async {
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    var calls = 0;
    final client = MockClient((request) async {
      calls++;
      expect(request.url.path, '/v1/me');
      return http.Response(
        jsonEncode(
          readyMe()
            ..['requiredConsents'] = {
              'current': false,
              'missing': ['terms_of_service'],
            },
        ),
        200,
      );
    });
    addTearDown(client.close);
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: client,
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    await expectLater(
      api.submit(IntakeSubmission('合成の症状')),
      throwsA(isA<IntakeApiException>()),
    );
    expect(calls, 1);
  });

  test('a changed session cannot accept an in-flight response', () async {
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    var current = true;
    final client = MockClient((request) async {
      current = false;
      return http.Response(jsonEncode(readyMe()), 200);
    });
    addTearDown(client.close);
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: client,
      identity: () async => owner,
      isCurrent: (_) => current,
    );
    await expectLater(
      api.submit(IntakeSubmission('合成の症状')),
      throwsA(
        isA<IntakeApiException>().having(
          (e) => e.code,
          'code',
          'SESSION_CHANGED',
        ),
      ),
    );
  });

  test('redirect and oversized responses never grant access', () async {
    for (final response in [
      http.Response('', 302),
      http.Response('x' * (256 * 1024 + 1), 200),
    ]) {
      final client = MockClient((_) async => response);
      final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
      final api = PatientIntakeApi(
        origin: 'http://127.0.0.1:8080',
        client: client,
        identity: () async => owner,
        isCurrent: (_) => true,
      );
      await expectLater(api.requireReady(), throwsA(isA<IntakeApiException>()));
      client.close();
    }
  });

  test('production and lookalike origins are rejected before networking', () {
    final client = MockClient((_) async => throw StateError('must not send'));
    addTearDown(client.close);
    for (final origin in [
      'https://api.example.com',
      'http://localhost.evil:8080',
      'http://127.0.0.1:8080/path',
    ]) {
      expect(
        () => PatientIntakeApi(
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
