import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/patient_intake_api.dart';
import 'package:patient/patient_intake_screen.dart';
import 'package:patient/patient_theme.dart';

class _LiveBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');
  if (enabled) _LiveBinding();
  // E2E-001C（docs/03 §10 / §3.1）: Google/Passkey 初回利用のように、認証済みだが
  // アプリのアカウント文書がまだ無い（legal_pending）利用者は、問診へ進めず同意ゲートで
  // 止まる。OAuth で先に作られた Auth UID をアプリ利用権限と区別することを検証する。
  testWidgets('a federated first-use account (no profile) is gated before intake', (tester) async {
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
      await tester.enterText(find.byType(TextField).at(0), 'synthetic-federated-new@example.test');
      await tester.enterText(find.byType(TextField).at(1), 'local-only-federated-123!');
      await tester.runAsync(() async { await tester.tap(find.text('ログイン')); });
      final gated = await appears(find.textContaining('同意・プロフィール登録の完了したアカウント'));
      expect(gated, isTrue, reason: 'a federated account without an app profile should be gated');
      expect(find.text('症状（必須）'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    } finally { client.close(); await changes.close(); }
  }, skip: !enabled);
}
