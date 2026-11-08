import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/patient_analytics.dart';
import 'package:patient/public_patient_api.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  PublicPatientApi api(
    Future<http.Response> Function(http.Request) respond, {
    PatientAnalytics analytics = const PatientAnalytics.disabled(),
    Object Function()? session,
  }) {
    final owner = Object();
    return PublicPatientApi(
      origin: 'https://api.example.test',
      client: MockClient(respond),
      tokens: () async =>
          (auth: 'SYNTHETIC_AUTH_TOKEN', appCheck: 'SYNTHETIC_APP_CHECK'),
      session: session ?? () => owner,
      analytics: analytics,
    );
  }

  test('default-disabled workflows continue without monitoring', () async {
    final client = api((_) async => http.Response('{}', 200));
    expect(
      await client.request('POST', '/intakes/synthetic/finalize'),
      isEmpty,
    );
    const PatientAnalytics.disabled().record(
      PatientAnalyticsEvent.deliveryFailed,
    );
    // Non-iOS initialization never needs a configured Firebase app.
    final disabled = await PatientAnalytics.initialize();
    disabled.record(PatientAnalyticsEvent.intakeCompleted);
  });

  test(
    'operational events contain no patient, request or error payload',
    () async {
      final sent = <String>[];
      final monitor = PatientAnalytics(send: (event) async => sent.add(event));
      final client = api(
        (r) async => r.url.path.endsWith('finalize')
            ? http.Response(
                '{"questionnaireId":"SYNTHETIC_QUESTIONNAIRE"}',
                200,
              )
            : http.Response('SYNTHETIC_PRIVATE_ERROR', 503),
        analytics: monitor,
      );
      await client.request(
        'POST',
        '/intakes/SYNTHETIC_PATIENT/finalize',
        body: {'symptoms': '合成症状', 'medication': '合成薬剤'},
        key: 'SYNTHETIC_IDEMPOTENCY',
      );
      await expectLater(
        client.request(
          'POST',
          '/deliveries',
          body: {'facilityId': 'SYNTHETIC_FACILITY'},
        ),
        throwsA(isA<PatientRequestFailure>()),
      );
      await Future<void>.delayed(Duration.zero);
      expect(sent, ['intake_completed', 'delivery_failed']);
      expect(jsonEncode(sent), isNot(contains('SYNTHETIC')));
      expect(jsonEncode(sent), isNot(contains('合成')));
    },
  );

  test(
    'only a successful finalize produces completion; reads do not',
    () async {
      final sent = <String>[];
      final monitor = PatientAnalytics(send: (event) async => sent.add(event));
      await api(
        (_) async => http.Response('{}', 200),
        analytics: monitor,
      ).request('GET', '/intakes/synthetic/finalize');
      await api(
        (_) async => http.Response('{}', 200),
        analytics: monitor,
      ).request('POST', '/deliveries');
      await expectLater(
        api(
          (_) async => http.Response('{}', 409),
          analytics: monitor,
        ).request('POST', '/intakes/synthetic/finalize'),
        throwsA(isA<PatientRequestFailure>()),
      );
      expect(sent, isEmpty);
    },
  );

  test('stale successful response never reports a completion', () async {
    var owner = Object();
    final sent = <String>[];
    final client = api(
      (_) async {
        owner = Object();
        return http.Response('{}', 200);
      },
      session: () => owner,
      analytics: PatientAnalytics(send: (event) async => sent.add(event)),
    );
    await expectLater(
      client.request('POST', '/intakes/synthetic/finalize'),
      throwsA(isA<PatientRequestFailure>()),
    );
    expect(sent, isEmpty);
  });

  test(
    'SDK synchronous and asynchronous failures cannot fail patient API',
    () async {
      for (final send in <Future<void> Function(String)>[
        (_) => throw StateError('SYNTHETIC_SDK_FAILURE'),
        (_) async => throw StateError('SYNTHETIC_SDK_FAILURE'),
      ]) {
        final client = api(
          (_) async => http.Response('{}', 200),
          analytics: PatientAnalytics(send: send),
        );
        expect(
          await client.request('POST', '/intakes/synthetic/finalize'),
          isEmpty,
        );
      }
      await Future<void>.delayed(Duration.zero);
    },
  );

  test('pending monitoring never delays response and transport errors are fixed events', () async {
    final pending = Completer<void>();
    final client = api(
      (_) async => http.Response('{}', 200),
      analytics: PatientAnalytics(send: (_) => pending.future),
    );
    expect(
      await client.request('POST', '/intakes/synthetic/finalize'),
      isEmpty,
    );
    pending.complete();
    final sent = <String>[];
    await expectLater(
      api(
        (_) async => throw StateError('SYNTHETIC_PRIVATE_EXCEPTION'),
        analytics: PatientAnalytics(send: (event) async => sent.add(event)),
      ).request('POST', '/deliveries'),
      throwsA(isA<PatientRequestFailure>()),
    );
    expect(sent, ['delivery_failed']);
  });

  test(
    'native collection is permanently stopped in shipped configurations',
    () {
      final ios = File('ios/Runner/Info.plist').readAsStringSync();
      expect(
        ios,
        matches(
          RegExp(
            r'<key>FIREBASE_ANALYTICS_COLLECTION_DEACTIVATED</key>\s*<true/>',
          ),
        ),
      );
      expect(
        ios,
        matches(
          RegExp(
            r'<key>FirebaseAutomaticScreenReportingEnabled</key>\s*<false/>',
          ),
        ),
      );
      expect(
        ios,
        matches(
          RegExp(
            r'<key>GOOGLE_ANALYTICS_IDFV_COLLECTION_ENABLED</key>\s*<false/>',
          ),
        ),
      );
      final android = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();
      expect(
        android,
        contains(
          'android:name="firebase_analytics_collection_deactivated" android:value="true"',
        ),
      );
    },
  );
}
