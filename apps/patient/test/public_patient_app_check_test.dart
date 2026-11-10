import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_app_check.dart';
import 'package:patient/public_patient_screen.dart';

void main() {
  for (final failure in ['exception', 'null', 'empty']) {
    test('App Check $failure blocks HTTP and permits a later retry', () async {
      var attempts = 0;
      var requests = 0;
      final epoch = Object();
      final client = MockClient((request) async {
        requests++;
        expect(request.headers['x-firebase-appcheck'], 'synthetic-check');
        return http.Response('{}', 200);
      });
      addTearDown(client.close);
      final api = PublicPatientApi(
        origin: 'https://api.example.test',
        client: client,
        session: () => epoch,
        tokens: () async => (
          auth: null,
          appCheck: await patientAppCheckToken(() async {
            if (++attempts > 1) return 'synthetic-check';
            if (failure == 'exception') throw StateError('private SDK details');
            return failure == 'null' ? null : '';
          }),
        ),
      );
      await expectLater(
        api.request('GET', '/public/legal-documents', authenticated: false),
        throwsA(
          isA<PatientRequestFailure>().having(
            (e) => e.code,
            'code',
            'APP_CHECK_UNAVAILABLE',
          ),
        ),
      );
      expect(requests, 0);
      expect(
        await api.request(
          'GET',
          '/public/legal-documents',
          authenticated: false,
        ),
        isEmpty,
      );
      expect(requests, 1);
    });
  }

  testWidgets(
    'registration explains attestation failure without blaming input',
    (tester) async {
      var requests = 0;
      final client = MockClient((_) async {
        requests++;
        return http.Response('{}', 200);
      });
      addTearDown(client.close);
      final epoch = Object();
      await tester.pumpWidget(
        MaterialApp(
          home: PublicPatientScreen(
            api: PublicPatientApi(
              origin: 'https://api.example.test',
              client: client,
              session: () => epoch,
              tokens: () async => (
                auth: null,
                appCheck: await patientAppCheckToken(
                  () async => throw StateError('private SDK details'),
                ),
              ),
            ),
            signIn: (_, _) async {},
            signOut: () async {},
            resetPassword: (_) async {},
            changes: const Stream.empty(),
          ),
        ),
      );
      final register = find.text('初めてご利用の方（新規登録）');
      await tester.ensureVisible(register);
      await tester.tap(register);
      await tester.pumpAndSettle();
      expect(
        find.text(const PatientRequestFailure('APP_CHECK_UNAVAILABLE').message),
        findsOneWidget,
      );
      expect(find.textContaining('private SDK details'), findsNothing);
      expect(find.text('操作を完了できません。入力内容と接続を確認してください。'), findsNothing);
      expect(find.text('ログインの有効期限が切れました。ログインし直してください。'), findsNothing);
      expect(register, findsOneWidget);
      expect(requests, 0);
    },
  );
}
