import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

void main() {
  for (final validDocument in [true, false]) {
    testWidgets(
      validDocument
          ? 'delivery sends explicit consent with current document and exact scope'
          : 'missing disclosure hash prevents delivery',
      (tester) async {
        Map<String, dynamic>? sent;
        final epoch = Object();
        final client = MockClient((request) async {
          Object response;
          switch (request.url.path) {
            case '/v1/me':
              response = {
                'accountStatus': 'active',
                'emailVerified': true,
                'profileComplete': true,
                'requiredConsents': {'current': true},
              };
            case '/v1/questionnaires':
              response = {
                'questionnaires': [
                  {'questionnaireId': 'synthetic-questionnaire'},
                ],
              };
            case '/v1/questionnaires/synthetic-questionnaire':
              response = {
                'questionnaireId': 'synthetic-questionnaire',
                'revision': {'versionNumber': 2},
              };
            case '/v1/facilities/synthetic-facility':
              response = {
                'facilityId': 'synthetic-facility',
                'displayName': '合成データ施設',
                'verificationStatus': 'verified',
                'receivingEnabled': true,
              };
            case '/v1/public/legal-documents':
              response = {
                'documents': {
                  'hospital_disclosure': {
                    'version': 'synthetic-v2',
                    if (validDocument) 'documentHash': 'synthetic-hash',
                  },
                },
              };
            case '/v1/deliveries':
              sent = jsonDecode(request.body) as Map<String, dynamic>;
              response = {'deliveryId': 'synthetic-delivery'};
            case '/v1/deliveries/synthetic-delivery':
              response = {'status': 'delivered'};
            default:
              fail('Unexpected request path: ${request.url.path}');
          }
          return http.Response(
            jsonEncode(response),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        });
        addTearDown(client.close);
        await tester.pumpWidget(
          MaterialApp(
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
              changes: const Stream<void>.empty(),
            ),
          ),
        );
        Future<void> tap(String label) async {
          await tester.ensureVisible(find.text(label));
          await tester.tap(find.text(label));
          await tester.pumpAndSettle();
        }

        await tap('ログイン');
        await tap('過去の問診票を見る');
        await tap('確定済み問診票');
        await tester.enterText(find.byType(TextField), 'synthetic-facility');
        await tap('施設を確認');
        expect(sent, isNull);
        if (validDocument) {
          final button = tester.widget<FilledButton>(
            find.widgetWithText(FilledButton, '同意した施設へ送信'),
          );
          expect(button.onPressed, isNull);
          await tap('氏名・連絡先と持病を一緒に共有する');
          await tap('「合成データ施設」へ、この問診票と選択した情報を送信することに同意します');
          expect(sent, isNull);
          await tap('同意した施設へ送信');
          final scope = {
            'includeProfile': true,
            'includeConfirmedMedications': false,
            'includePrescriptionImages': false,
          };
          expect(sent, {
            'questionnaireId': 'synthetic-questionnaire',
            'questionnaireRevision': 2,
            'facilityId': 'synthetic-facility',
            'shareScope': scope,
            'consent': {
              'accepted': true,
              'documentVersion': 'synthetic-v2',
              'documentHash': 'synthetic-hash',
              'shareScope': scope,
            },
          });
          expect(find.text('施設の受信箱へ届きました'), findsOneWidget);
        } else {
          expect(find.text('同意した施設へ送信'), findsNothing);
          expect(sent, isNull);
          expect(find.textContaining('現在の利用状態では操作できません'), findsOneWidget);
        }
      },
    );
  }
}
