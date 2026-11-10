import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

const types = [
  'terms_of_service',
  'privacy_policy_ack',
  'health_data_collection',
];
http.Response jsonResponse(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Future<void> tap(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label));
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

Widget app(
  http.Client client, {
  Future<bool> Function()? verified,
  Future<void> Function()? send,
  Stream<void> changes = const Stream.empty(),
}) {
  final epoch = Object();
  return MaterialApp(
    home: PublicPatientScreen(
      api: PublicPatientApi(
        origin: 'https://api.example.test',
        client: client,
        tokens: () async => (auth: 'synthetic', appCheck: 'synthetic'),
        session: () => epoch,
      ),
      signIn: (_, _) async {},
      signOut: () async {},
      resetPassword: (_) async {},
      refreshEmailVerification: verified,
      sendEmailVerification: send,
      changes: changes,
    ),
  );
}

void main() {
  testWidgets(
    'unverified email has a verification step and never opens intake',
    (tester) async {
      var sent = 0;
      final client = MockClient(
        (_) async =>
            throw StateError('API must not be called before verification'),
      );
      addTearDown(client.close);
      await tester.pumpWidget(
        app(
          client,
          verified: () async => false,
          send: () async {
            sent++;
          },
        ),
      );
      await tap(tester, 'ログイン');
      expect(find.text('メールアドレスの確認'), findsOneWidget);
      expect(sent, 0);
      await tap(tester, '確認メールを送信');
      expect(sent, 1);
      await tap(tester, '確認状況を更新');
      expect(find.text('新しい問診をはじめる'), findsNothing);
    },
  );

  for (final hasText in [true, false]) {
    testWidgets(
      hasText
          ? 'explicit consent and saved profile unlock intake'
          : 'metadata alone cannot grant consent',
      (tester) async {
        var consentSaved = false, profileSaved = false;
        Map<String, dynamic>? submittedProfile;
        String? consentKey;
        final client = MockClient((r) async {
          switch (r.url.path) {
            case '/v1/me':
              return jsonResponse({
                'accountStatus': profileSaved ? 'active' : null,
                'emailVerified': true,
                'profileComplete': profileSaved,
                'requiredConsents': {'current': consentSaved},
              });
            case '/v1/public/legal-documents':
              return jsonResponse({
                'requiredConsents': types,
                'documents': {
                  for (final t in types)
                    t: {
                      'version': 'synthetic-v1',
                      'documentHash': 'synthetic-hash',
                      if (hasText) 'text': '合成文書本文 $t',
                    },
                },
              });
            case '/v1/onboarding/consents':
              expect(consentSaved, false);
              final body = jsonDecode(r.body) as Map;
              for (final t in types) {
                expect(body['consents'][t], {
                  'accepted': true,
                  'documentVersion': 'synthetic-v1',
                });
              }
              consentKey = r.headers['Idempotency-Key'];
              expect(consentKey, isNotEmpty);
              consentSaved = true;
              return jsonResponse({'onboardingState': 'profile_pending'});
            case '/v1/me/profile':
              expect(consentSaved, true);
              expect(r.method, 'PATCH');
              submittedProfile = jsonDecode(r.body) as Map<String, dynamic>;
              profileSaved = true;
              return jsonResponse({'profileComplete': true});
            default:
              throw StateError('Unexpected ${r.url.path}');
          }
        });
        addTearDown(client.close);
        await tester.pumpWidget(app(client, verified: () async => true));
        await tap(tester, 'ログイン');
        if (!hasText) {
          expect(find.textContaining('運営者による文書の準備'), findsOneWidget);
          expect(consentSaved, false);
          expect(find.text('同意して登録を続ける'), findsNothing);
          return;
        }
        expect(find.text('ご利用前の確認'), findsOneWidget);
        final disabled = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, '同意して登録を続ける'),
        );
        expect(disabled.onPressed, isNull);
        expect(consentSaved, false);
        for (final text in [
          '利用規約に同意する',
          'プライバシーについてに同意する',
          '健康情報の取得についてに同意する',
        ]) {
          await tap(tester, text);
        }
        await tap(tester, '同意して登録を続ける');
        expect(find.text('プロフィール登録'), findsOneWidget);
        expect(find.text('新しい問診をはじめる'), findsNothing);
        const values = [
          '合成',
          '患者',
          'ゴウセイ',
          'カンジャ',
          '1990-01-01',
          '0312345678',
          '1000001',
          '東京都',
          '架空区',
          '架空1',
        ];
        for (var i = 0; i < values.length; i++) {
          final field = find.byType(TextField).at(i);
          await tester.ensureVisible(field);
          await tester.enterText(field, values[i]);
        }
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        await tap(tester, 'プロフィールを保存して問診へ');
        expect(find.textContaining('入力内容を確認'), findsNothing);
        expect(submittedProfile?['address'], {
          'prefecture': '東京都',
          'city': '架空区',
          'line1': '架空1',
        });
        expect(find.text('新しい問診をはじめる'), findsOneWidget);
        await tap(tester, '新しい問診をはじめる');
        expect(find.text('気になる症状を入力'), findsOneWidget);
      },
    );
  }
}
