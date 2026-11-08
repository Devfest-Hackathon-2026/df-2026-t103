import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/patient_intake_api.dart';
import 'package:patient/patient_intake_screen.dart';
import 'package:patient/patient_theme.dart';

// Real network only when explicitly selected, with loopback-only client guards.
class _LiveBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');
  if (enabled) _LiveBinding();
  // E2E-001B（docs/03 §10）: 必須同意が未完了のアカウントは、実サインインに成功しても
  // 問診（症状入力）へ進めず、同意・プロフィール完了を促すゲートで止まる。
  testWidgets('real sign-in with pending consent is gated before intake', (tester) async {
    final client = http.Client();
    final changes = StreamController<void>.broadcast(sync: true);
    IntakeIdentity? owner;
    final api = PatientIntakeApi(origin: 'http://127.0.0.1:8080', client: client,
      identity: () async => owner ?? (throw const IntakeApiException('SIGNED_OUT')),
      isCurrent: (value) => identical(value, owner));
    Future<bool> appears(Finder finder) async {
      for (var attempt = 0; attempt < 120; attempt++) {
        await tester.pump();
        if (finder.evaluate().isNotEmpty) return true;
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      }
      return false;
    }
    try {
      await tester.pumpWidget(MaterialApp(theme: buildPatientTheme(), home: PatientIntakeScreen(
        api: api, sessionChanges: changes.stream,
        signIn: (email, password) async {
          final response = await client.post(Uri.parse('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key'),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'email': email, 'password': password, 'returnSecureToken': true}));
          expect(response.statusCode, 200);
          final data = jsonDecode(response.body) as Map<String, dynamic>;
          owner = IntakeIdentity(data['localId'] as String, Object(), data['idToken'] as String);
          changes.add(null);
        },
        signOut: () async { owner = null; changes.add(null); },
      )));
      await tester.enterText(find.byType(TextField).at(0), 'synthetic-consent-gate@example.test');
      await tester.enterText(find.byType(TextField).at(1), 'local-only-gate-123!');
      await tester.runAsync(() async { await tester.tap(find.text('ログイン')); });
      // The consent gate message appears; the symptom field never does.
      final gated = await appears(find.textContaining('同意・プロフィール登録の完了したアカウント'));
      expect(gated, isTrue, reason: 'consent-gated account should surface the gate message');
      expect(find.text('症状（必須）'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    } finally { client.close(); await changes.close(); }
  }, skip: !enabled);
}
