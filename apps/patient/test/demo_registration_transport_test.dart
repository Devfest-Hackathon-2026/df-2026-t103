import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/demo_registration_transport.dart';
import 'package:patient/firebase_bootstrap.dart' show isDemoEmulatorHost;

class TestClient extends http.BaseClient {
  TestClient(this.handler);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handler;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      handler(request);
}

/// Origins that must never be accepted, whatever the platform reports.
const rejectedOrigins = [
  'https://localhost:8080',
  'http://localhost',
  'http://localhost:8081',
  'http://localhost:8080/',
  'http://localhost:8080/v1/auth/register',
  'http://localhost:8080?x=1',
  'http://localhost:8080#x',
  'http://localhost:8080@evil.example:8080',
  'http://localhost.evil:8080',
  'http://127.0.0.2:8080',
  'http://[::1]:8080',
  'http://10.0.2.2',
  'http://10.0.2.2:8081',
  'http://10.0.2.2:8080/',
  'http://10.0.2.2.evil.example:8080',
  'http://10.0.2.3:8080',
];

void main() {
  const headers = {
    'Idempotency-Key': 'test-key',
    'X-Firebase-AppCheck': 'test-token',
  };
  const body = <String, Object>{
    'email': 'person@example.invalid',
    'password': 'example',
  };

  test('posts JSON and required headers to the fixed local endpoint', () async {
    // The alias origin is Android-only, so pin the platform instead of
    // relying on the platform of the machine that runs the test.
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    for (final host in ['localhost', '127.0.0.1', '10.0.2.2']) {
      final client = TestClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.toString(), 'http://$host:8080/v1/auth/register');
        expect(request.followRedirects, isFalse);
        expect(
          request.headers['content-type'],
          'application/json; charset=utf-8',
        );
        expect(request.headers['idempotency-key'], 'test-key');
        expect(request.headers['x-firebase-appcheck'], 'test-token');
        expect(
          jsonDecode(utf8.decode(await request.finalize().toBytes())),
          body,
        );
        return http.StreamedResponse(Stream.value(utf8.encode('{}')), 201);
      });
      final transport = DemoRegistrationTransport(
        baseUrl: 'http://$host:8080',
        client: client,
      );
      expect(
        await transport.postRegistration(headers: headers, body: body),
        201,
      );
    }
  });

  test('rejects anything other than an explicitly allowed origin', () {
    final client = TestClient((_) => throw StateError('must not send'));
    for (final origin in rejectedOrigins) {
      expect(
        () => DemoRegistrationTransport(baseUrl: origin, client: client),
        throwsArgumentError,
        reason: origin,
      );
    }
  });

  group('allowsDemoApiOrigin', () {
    test('accepts loopback origins in both platform modes', () {
      for (final origin in ['http://localhost:8080', 'http://127.0.0.1:8080']) {
        expect(
          allowsDemoApiOrigin(origin, androidHostAliasAllowed: false),
          isTrue,
          reason: origin,
        );
        expect(
          allowsDemoApiOrigin(origin, androidHostAliasAllowed: true),
          isTrue,
          reason: origin,
        );
      }
    });

    test('accepts the Android alias origin only when it is allowed', () {
      const origin = 'http://10.0.2.2:8080';
      expect(
        allowsDemoApiOrigin(origin, androidHostAliasAllowed: true),
        isTrue,
      );
      expect(
        allowsDemoApiOrigin(origin, androidHostAliasAllowed: false),
        isFalse,
      );
    });

    test('rejects every other origin in both platform modes', () {
      for (final origin in rejectedOrigins) {
        expect(
          allowsDemoApiOrigin(origin, androidHostAliasAllowed: false),
          isFalse,
          reason: origin,
        );
        expect(
          allowsDemoApiOrigin(origin, androidHostAliasAllowed: true),
          isFalse,
          reason: origin,
        );
      }
    });

    test('stays aligned with the Firebase emulator host guard', () {
      const originByHost = {
        'http://localhost:8080': 'localhost',
        'http://127.0.0.1:8080': '127.0.0.1',
        'http://10.0.2.2:8080': '10.0.2.2',
      };
      for (final entry in originByHost.entries) {
        for (final allowed in [true, false]) {
          expect(
            allowsDemoApiOrigin(entry.key, androidHostAliasAllowed: allowed),
            isDemoEmulatorHost(entry.value, androidHostAliasAllowed: allowed),
            reason: '${entry.key} (androidHostAliasAllowed: $allowed)',
          );
        }
      }
    });
  });

  group('default constructor platform gate', () {
    test('rejects the alias origin and keeps loopback off Android', () {
      // kIsWeb is a compile-time constant, so the web build cannot be
      // simulated in a VM test; only the platform half is covered here.
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final client = TestClient((_) => throw StateError('must not send'));
      const nonAndroid = [
        TargetPlatform.iOS,
        TargetPlatform.macOS,
        TargetPlatform.linux,
        TargetPlatform.windows,
        TargetPlatform.fuchsia,
      ];
      for (final platform in nonAndroid) {
        debugDefaultTargetPlatformOverride = platform;
        expect(
          () => DemoRegistrationTransport(
            baseUrl: 'http://10.0.2.2:8080',
            client: client,
          ),
          throwsArgumentError,
          reason: '$platform',
        );
        for (final origin in [
          'http://localhost:8080',
          'http://127.0.0.1:8080',
        ]) {
          expect(
            () => DemoRegistrationTransport(baseUrl: origin, client: client),
            returnsNormally,
            reason: '$platform $origin',
          );
        }
      }
    });

    test('accepts the alias origin on Android', () {
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      expect(
        () => DemoRegistrationTransport(
          baseUrl: 'http://10.0.2.2:8080',
          client: TestClient((_) => throw StateError('must not send')),
        ),
        returnsNormally,
      );
    });
  });

  test('rejects redirect responses without following them', () async {
    var calls = 0;
    final client = TestClient((request) async {
      calls++;
      expect(request.followRedirects, isFalse);
      return http.StreamedResponse(
        const Stream.empty(),
        307,
        headers: {'location': 'http://evil.example/'},
      );
    });
    final transport = DemoRegistrationTransport(
      baseUrl: 'http://localhost:8080',
      client: client,
    );
    await expectLater(
      transport.postRegistration(headers: headers, body: body),
      throwsStateError,
    );
    expect(calls, 1);
  });

  test('rejects oversized, invalid, failed and timed-out responses', () async {
    final responses =
        <Future<http.StreamedResponse> Function(http.BaseRequest)>[
          (_) async => http.StreamedResponse(
            const Stream.empty(),
            201,
            contentLength: 65537,
          ),
          (_) async =>
              http.StreamedResponse(Stream.value(List.filled(65537, 0)), 201),
          (_) async => http.StreamedResponse(const Stream.empty(), 600),
          (_) async => throw Exception('sensitive detail'),
          (_) => Completer<http.StreamedResponse>().future,
        ];
    for (final handler in responses) {
      final transport = DemoRegistrationTransport(
        baseUrl: 'http://localhost:8080',
        client: TestClient(handler),
        timeout: const Duration(milliseconds: 20),
      );
      await expectLater(
        transport.postRegistration(headers: headers, body: body),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            'Registration transport failed',
          ),
        ),
      );
    }
  });

  test('returns API rejection status and rejects unapproved headers', () async {
    var calls = 0;
    final transport = DemoRegistrationTransport(
      baseUrl: 'http://localhost:8080',
      client: TestClient((_) async {
        calls++;
        return http.StreamedResponse(const Stream.empty(), 412);
      }),
    );
    expect(await transport.postRegistration(headers: headers, body: body), 412);
    await expectLater(
      transport.postRegistration(headers: {'Host': 'evil.example'}, body: body),
      throwsArgumentError,
    );
    expect(calls, 1);
  });
}
