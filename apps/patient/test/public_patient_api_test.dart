import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_config.dart';

void main() {
  test('iOS config accepts native settings and rejects Web identity', () {
    PublicPatientConfig native({
      String appId = '1:842827776169:ios:synthetic',
    }) => PublicPatientConfig(
      projectId: 'project-7efcc4c4-6c86-490c-ba5',
      apiOrigin: 'https://api.example.test',
      apiKey: 'synthetic-public-key',
      appId: appId,
    );
    expect(
      () => native().validate(platform: PublicPatientPlatform.ios),
      returnsNormally,
    );
    expect(native().validate, throwsStateError);
    for (final appId in [
      '1:842827776169:web:synthetic',
      '1:842827776169:android:synthetic',
      '1:123:ios:synthetic',
      '1:842827776169:ios:',
    ]) {
      expect(
        () =>
            native(appId: appId).validate(platform: PublicPatientPlatform.ios),
        throwsStateError,
      );
    }
  });
  test('public config rejects emulator, mixed project and URL injection', () {
    PublicPatientConfig config({
      String project = 'project-7efcc4c4-6c86-490c-ba5',
      String origin = 'https://api.example.test',
      String key = 'public-key',
    }) => PublicPatientConfig(
      projectId: project,
      apiOrigin: origin,
      apiKey: key,
      appId: '1:842827776169:web:synthetic',
      authDomain: 'project-7efcc4c4-6c86-490c-ba5.firebaseapp.com',
      siteKey: 'public-site-key',
    );
    expect(config().validate, returnsNormally);
    for (final value in [
      'http://localhost:8080',
      'https://user:pass@api.example.test',
      'https://api.example.test/path',
      'https://api.example.test?key=x',
      'https://api.example.test/',
    ]) {
      expect(() => config(origin: value).validate(), throwsStateError);
    }
    expect(() => config(project: 'demo-mmr-dev').validate(), throwsStateError);
    expect(() => config(key: '').validate(), throwsStateError);
  });
  test(
    'Auth and App Check refreshed, idempotency retained and redirects denied',
    () async {
      final epoch = Object();
      var refreshed = 0;
      final api = PublicPatientApi(
        origin: 'https://api.example.test',
        session: () => epoch,
        tokens: () async {
          refreshed++;
          return (auth: 'synthetic-auth', appCheck: 'synthetic-appcheck');
        },
        client: MockClient((r) async {
          expect(r.headers['authorization'], 'Bearer synthetic-auth');
          expect(r.headers['x-firebase-appcheck'], 'synthetic-appcheck');
          expect(r.headers['idempotency-key'], 'same-attempt');
          expect(r.followRedirects, false);
          return http.Response('{"deliveryId":"delivery-test"}', 202);
        }),
      );
      for (var i = 0; i < 2; i++) {
        expect(
          (await api.request(
            'POST',
            '/deliveries',
            key: 'same-attempt',
            body: {'synthetic': true},
          ))['deliveryId'],
          'delivery-test',
        );
      }
      expect(refreshed, 2);
    },
  );
  test(
    'public registration sends App Check without Firebase ID token',
    () async {
      final epoch = Object();
      final api = PublicPatientApi(
        origin: 'https://api.example.test',
        session: () => epoch,
        tokens: () async => (auth: null, appCheck: 'synthetic-appcheck'),
        client: MockClient((request) async {
          expect(request.url.path, '/v1/auth/register');
          expect(request.headers.containsKey('authorization'), isFalse);
          expect(request.headers['x-firebase-appcheck'], 'synthetic-appcheck');
          expect(request.headers['idempotency-key'], 'same-attempt');
          return http.Response('{"uid":"synthetic-user"}', 201);
        }),
      );
      await api.request(
        'POST',
        '/auth/register',
        authenticated: false,
        key: 'same-attempt',
        body: {'email': 'synthetic@example.test'},
      );
      await expectLater(
        api.request('GET', '/me'),
        throwsA(isA<PatientRequestFailure>()),
      );
    },
  );
  test(
    'auth changes during credentials or response reject stale data',
    () async {
      var epoch = Object();
      var sent = false;
      final ready = Completer<({String auth, String appCheck})>();
      final api = PublicPatientApi(
        origin: 'https://api.example.test',
        session: () => epoch,
        tokens: () => ready.future,
        client: MockClient((r) async {
          sent = true;
          return http.Response('{}', 200);
        }),
      );
      final rejected = expectLater(
        api.request('GET', '/me'),
        throwsA(isA<PatientRequestFailure>()),
      );
      epoch = Object();
      ready.complete((auth: 'test', appCheck: 'test'));
      await rejected;
      expect(sent, false);
      final responseReady = Completer<http.Response>();
      final other = PublicPatientApi(
        origin: 'https://api.example.test',
        session: () => epoch,
        tokens: () async => (auth: 'test', appCheck: 'test'),
        client: MockClient((r) => responseReady.future),
      );
      final stale = expectLater(
        other.request('GET', '/me'),
        throwsA(isA<PatientRequestFailure>()),
      );
      await Future<void>.delayed(Duration.zero);
      epoch = Object();
      responseReady.complete(http.Response('{"private":"SYNTHETIC"}', 200));
      await stale;
    },
  );
  test('server errors and invalid/oversized responses are sanitized', () async {
    final epoch = Object();
    for (final response in [
      http.Response('SYNTHETIC_PRIVATE_FAILURE', 403),
      http.Response('[]', 200),
      http.Response('x' * (512 * 1024 + 1), 200),
    ]) {
      final api = PublicPatientApi(
        origin: 'https://api.example.test',
        session: () => epoch,
        tokens: () async => (auth: 'test', appCheck: 'test'),
        client: MockClient((r) async => response),
      );
      try {
        await api.request('GET', '/me');
        fail('Must reject');
      } on PatientRequestFailure catch (e) {
        expect(e.message, isNot(contains('SYNTHETIC_PRIVATE_FAILURE')));
      }
    }
  });
  test('bad path rejected before credentials', () async {
    final api = PublicPatientApi(
      origin: 'https://api.example.test',
      session: () => Object(),
      tokens: () async => throw StateError('Must not request'),
      client: MockClient((r) async => http.Response('{}', 200)),
    );
    await expectLater(
      api.request('GET', '/me?token=bad'),
      throwsA(isA<PatientRequestFailure>()),
    );
  });
}
