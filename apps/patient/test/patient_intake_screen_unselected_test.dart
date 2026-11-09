import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/patient_intake_api.dart';
import 'package:patient/patient_intake_screen.dart';

http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
    http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  testWidgets(
    'saves symptoms without body locations and continues to questions',
    (tester) async {
      final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
      Map<String, dynamic>? symptomBody;
      var symptomsSaved = false;
      final client = MockClient((request) async {
        switch (request.url.path) {
          case '/v1/me':
            return _json({
              'uid': 'patient-a',
              'accountStatus': 'active',
              'onboardingState': 'completed',
              'emailVerified': true,
              'requiredConsents': {'current': true, 'missing': <String>[]},
              'profileComplete': true,
              'deletionRequest': {'status': 'none', 'canCancel': false},
            });
          case '/v1/intakes':
            return _json({
              'intakeId': 'test-intake',
              'status': 'draft',
              'revision': 1,
            }, 201);
          case '/v1/intakes/test-intake':
            return _json({
              'intakeId': 'test-intake',
              'status': symptomsSaved ? 'questioning' : 'draft',
              'revision': symptomsSaved ? 2 : 1,
              if (symptomsSaved) 'initialSymptomText': '合成の症状',
            });
          case '/v1/intakes/test-intake/symptoms':
            symptomBody = jsonDecode(request.body) as Map<String, dynamic>;
            symptomsSaved = true;
            return _json({});
          case '/v1/intakes/test-intake/next-question':
            return _json({
              'intakeId': 'test-intake',
              'intakeRevision': 3,
              'question': {
                'questionId': 'synthetic-question',
                'stepIndex': 0,
                'questionText': '合成の問診質問ですか？',
                'topic': 'onset_timing',
                'options': [
                  {'code': 'YES', 'label': 'はい'},
                ],
                'generatedBy': 'fixed',
                'modelVersion': 'test',
                'questionRevision': 1,
              },
            });
          default:
            fail('Unexpected request: ${request.url}');
        }
      });
      addTearDown(client.close);
      final api = PatientIntakeApi(
        origin: 'http://127.0.0.1:8080',
        client: client,
        identity: () async => owner,
        isCurrent: (_) => true,
      );
      final sessions = StreamController<void>();
      addTearDown(sessions.close);

      await tester.pumpWidget(
        MaterialApp(
          home: PatientIntakeScreen(
            api: api,
            signIn: (_, _) async {},
            signOut: () async {},
            sessionChanges: sessions.stream,
          ),
        ),
      );
      await tester.enterText(
        find.byType(TextField).at(0),
        'patient@example.test',
      );
      await tester.enterText(find.byType(TextField).at(1), 'password');
      await tester.tap(find.text('ログイン'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, '  合成の症状  ');
      expect(find.text('気になる部位（複数選択可・未選択でも可）'), findsOneWidget);
      await tester.ensureVisible(find.text('症状を保存'));
      await tester.tap(find.text('症状を保存'));
      await tester.pumpAndSettle();

      expect(symptomBody, isNotNull);
      expect(symptomBody!['initialSymptomText'], '合成の症状');
      expect(symptomBody!['bodyLocations'], isEmpty);
      expect(find.text('症状を保存しました。続けて質問にお答えください。'), findsOneWidget);
      expect(find.text('合成の問診質問ですか？'), findsOneWidget);
    },
  );
}
