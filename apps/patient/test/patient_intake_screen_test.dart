import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/patient_intake_api.dart';
import 'package:patient/patient_intake_screen.dart';

Map<String, dynamic> _readyMe() => {
  'uid': 'patient-a',
  'accountStatus': 'active',
  'onboardingState': 'completed',
  'emailVerified': true,
  'requiredConsents': {'current': true, 'missing': <String>[]},
  'profileComplete': true,
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

void main() {
  testWidgets('selects multiple locations and submits symptom text and codes', (
    tester,
  ) async {
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    Map<String, dynamic>? symptomBody;
    var wroteSymptoms = false;
    final client = MockClient((request) async {
      switch (request.url.path) {
        case '/v1/me':
          return http.Response(jsonEncode(_readyMe()), 200);
        case '/v1/intakes':
          return http.Response(
            jsonEncode({
              'intakeId': 'test-intake',
              'status': 'draft',
              'revision': 1,
            }),
            201,
          );
        case '/v1/intakes/test-intake/symptoms':
          symptomBody = jsonDecode(request.body) as Map<String, dynamic>;
          wroteSymptoms = true;
          return http.Response('{}', 200);
        case '/v1/intakes/test-intake':
          return http.Response(
            jsonEncode({
              'intakeId': 'test-intake',
              'status': wroteSymptoms ? 'questioning' : 'draft',
              'revision': wroteSymptoms ? 2 : 1,
              if (wroteSymptoms) 'initialSymptomText': '頭と左膝が痛みます',
            }),
            200,
          );
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

    await tester.enterText(find.byType(TextField).first, '  頭と左膝が痛みます  ');
    await tester.ensureVisible(find.text('頭'));
    final headTile = find
        .ancestor(of: find.text('頭'), matching: find.byType(CheckboxListTile))
        .first;
    await tester.tap(headTile);
    await tester.pump();
    await tester.ensureVisible(find.text('左膝'));
    final kneeTile = find
        .ancestor(of: find.text('左膝'), matching: find.byType(CheckboxListTile))
        .first;
    await tester.tap(kneeTile);
    await tester.pump();
    await tester.ensureVisible(find.text('症状を保存'));
    await tester.tap(find.text('症状を保存'));
    await tester.pumpAndSettle();

    expect(symptomBody, isNotNull);
    expect(symptomBody!['initialSymptomText'], '頭と左膝が痛みます');
    expect(symptomBody!['bodyLocations'], containsAll(['head', 'left_knee']));
    expect((symptomBody!['bodyLocations'] as List).length, 2);
  });

  testWidgets(
    'clears selected locations when the authenticated session changes',
    (tester) async {
      final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
      final client = MockClient(
        (_) async => http.Response(jsonEncode(_readyMe()), 200),
      );
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
      await tester.ensureVisible(find.text('頭'));
      await tester.tap(
        find
            .ancestor(
              of: find.text('頭'),
              matching: find.byType(CheckboxListTile),
            )
            .first,
      );
      await tester.pump();
      expect(
        tester
            .widget<CheckboxListTile>(
              find
                  .ancestor(
                    of: find.text('頭'),
                    matching: find.byType(CheckboxListTile),
                  )
                  .first,
            )
            .value,
        isTrue,
      );

      sessions.add(null);
      await tester.pumpAndSettle();

      expect(find.text('メールアドレス'), findsOneWidget);
      expect(find.text('症状（必須）'), findsNothing);
      // The selection is no longer rendered after the auth-state reset.
      await tester.enterText(
        find.byType(TextField).at(0),
        'patient@example.test',
      );
      await tester.enterText(find.byType(TextField).at(1), 'password');
      await tester.tap(find.text('ログイン'));
      await tester.pumpAndSettle();
      final tile = tester.widget<CheckboxListTile>(
        find
            .ancestor(
              of: find.text('頭'),
              matching: find.byType(CheckboxListTile),
            )
            .first,
      );
      expect(tile.value, isFalse);
    },
  );
}
