import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/patient_theme.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

class _LiveBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');
  if (enabled) _LiveBinding();

  testWidgets('public UI → real API → hospital receipt → logout', (
    tester,
  ) async {
    final client = http.Client();
    final changes = StreamController<void>.broadcast(sync: true);
    var epoch = Object();
    String? patientToken;
    const symptom = '合成データの問診入力です';
    Future<String> login(String email, String password) async {
      final response = await client.post(
        Uri.parse(
          'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key',
        ),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({
          'email': email,
          'password': password,
          'returnSecureToken': true,
        }),
      );
      expect(response.statusCode, 200);
      return (jsonDecode(response.body) as Map<String, dynamic>)['idToken']
          as String;
    }

    final api = PublicPatientApi(
      origin: 'http://127.0.0.1:8080',
      client: client,
      session: () => epoch,
      // Only the local demo API is permissive. This does not validate App Attest.
      tokens: () async => (auth: patientToken!, appCheck: 'emulator-only'),
    );
    Future<void> waitFor(Finder finder) async {
      for (var i = 0; i < 250; i++) {
        await tester.pump();
        if (finder.evaluate().isNotEmpty) return;
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
      }
      fail('Real public workflow did not reach the expected state: $finder');
    }

    Future<void> tap(String text) async {
      await tester.ensureVisible(find.text(text));
      await tester.runAsync(() async {
        await tester.tap(find.text(text));
      });
      await tester.pump();
      for (var i = 0; i < 250; i++) {
        if (find.byType(LinearProgressIndicator).evaluate().isEmpty) return;
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        await tester.pump();
      }
      fail('Public workflow operation did not finish: $text');
    }

    try {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildPatientTheme(),
          home: PublicPatientScreen(
            api: api,
            changes: changes.stream,
            initialFacilityId: 'synthetic-public-facility',
            signIn: (email, password) async {
              patientToken = await login(email, password);
              epoch = Object();
              changes.add(null);
            },
            signOut: () async {
              patientToken = null;
              epoch = Object();
              changes.add(null);
            },
            resetPassword: (_) async =>
                throw StateError('Email sending is not part of this test'),
          ),
        ),
      );
      await tester.enterText(
        find.byType(TextField).at(0),
        'synthetic-intake-ui@example.test',
      );
      await tester.enterText(
        find.byType(TextField).at(1),
        'local-only-intake-123!',
      );
      await tap('ログイン');
      await waitFor(find.text('新しい問診をはじめる'));
      await tap('新しい問診をはじめる');
      await tester.enterText(find.byType(TextField).first, symptom);
      await tap('保存して質問へ進む');
      for (var step = 0; step < 20; step++) {
        await waitFor(
          find.byWidgetPredicate(
            (w) => w is Text && (w.data == 'わからない' || w.data == '問診の内容を確認しました'),
          ),
        );
        if (find.text('問診の内容を確認しました').evaluate().isNotEmpty) break;
        await tap('わからない');
      }
      await waitFor(find.text('問診の内容を確認しました'));
      expect(find.text(symptom), findsOneWidget);
      await tap('問診の内容を確認しました');
      await tap('この内容で問診票を確定');
      await waitFor(find.text('合成データ受入施設'));
      await tap('「合成データ受入施設」へ、この問診票と選択した情報を送信することに同意します');
      await tap('同意した施設へ送信');
      await waitFor(find.text('施設の受信箱へ届きました'));
      final staffToken = await tester.runAsync(
        () => login(
          'synthetic-public-staff@example.test',
          'local-only-public-staff-123!',
        ),
      );
      final inbox = await tester.runAsync(
        () => client.get(
          Uri.parse(
            'http://127.0.0.1:8080/v1/hospitals/synthetic-public-facility/deliveries',
          ),
          headers: {'Authorization': 'Bearer $staffToken'},
        ),
      );
      expect(inbox!.statusCode, 200);
      final rows = (jsonDecode(inbox.body) as Map)['deliveries'] as List;
      expect(rows, isNotEmpty);
      final deliveryId = (rows.first as Map)['deliveryId'];
      final received = await tester.runAsync(
        () => client.get(
          Uri.parse(
            'http://127.0.0.1:8080/v1/hospitals/synthetic-public-facility/deliveries/$deliveryId',
          ),
          headers: {'Authorization': 'Bearer $staffToken'},
        ),
      );
      expect(received!.statusCode, 200);
      expect(
        (jsonDecode(received.body)
            as Map)['questionnaireSnapshot']['chiefComplaint']['value'],
        symptom,
      );
      await tap('ログアウト');
      await waitFor(find.text('ログイン'));
      expect(find.text(symptom), findsNothing);
      expect(find.text('施設の受信箱へ届きました'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    } finally {
      client.close();
      await changes.close();
    }
  }, skip: !enabled);
}
