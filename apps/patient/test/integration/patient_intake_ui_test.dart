import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:patient/patient_intake_api.dart';
import 'package:patient/patient_intake_screen.dart';
import 'package:patient/patient_theme.dart';

// Real network only when explicitly selected, with loopback-only client guards.
class _LiveBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

class _IntakeDetailRecordingClient extends http.BaseClient {
  _IntakeDetailRecordingClient(this._inner);

  final http.Client _inner;
  final details = <Map<String, dynamic>>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await _inner.send(request);
    if (request.method != 'GET' ||
        !RegExp(r'^/v1/intakes/[^/]+$').hasMatch(request.url.path) ||
        response.statusCode != 200) {
      return response;
    }

    // Retain the real API detail in memory while preserving the response for
    // the application. Never print or persist this potentially sensitive data.
    final bytes = await response.stream.toBytes();
    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is Map<String, dynamic>) details.add(decoded);
    return http.StreamedResponse(
      Stream<List<int>>.value(bytes),
      response.statusCode,
      contentLength: bytes.length,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  @override
  void close() => _inner.close();
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');
  if (enabled) _LiveBinding();
  testWidgets('real sign-in → symptom UI → API persistence → logout', (tester) async {
    // IntakeQuestionFlow が保存直後に next-question を実発火するため、
    // dart:io の HttpClient を直接保持し、teardown で force クローズして
    // keep-alive のアイドルタイマーを残さない（pending-timer invariant 対策）。
    final httpClient = HttpClient();
    final client = _IntakeDetailRecordingClient(IOClient(httpClient));
    final changes = StreamController<void>.broadcast(sync: true);
    IntakeIdentity? owner;
    final api = PatientIntakeApi(origin: 'http://127.0.0.1:8080', client: client,
      identity: () async => owner ?? (throw const IntakeApiException('SIGNED_OUT')),
      isCurrent: (value) => identical(value, owner));
    Future<void> waitFor(Finder finder) async {
      for (var attempt = 0; attempt < 200; attempt++) {
        await tester.pump();
        if (finder.evaluate().isNotEmpty) return;
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      }
      fail('Real workflow did not reach the expected UI state');
    }
    try {
      await tester.pumpWidget(MaterialApp(theme: buildPatientTheme(), home: PatientIntakeScreen(
        api: api, sessionChanges: changes.stream,
        signIn: (email, password) async {
          // Real Firebase Auth service, not a fake token or response. The normal
          // app uses FirebaseAuth SDK; this host widget test uses emulator REST.
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
      await tester.enterText(find.byType(TextField).at(0), 'synthetic-intake-ui@example.test');
      await tester.enterText(find.byType(TextField).at(1), 'local-only-intake-123!');
      await tester.runAsync(() async { await tester.tap(find.text('ログイン')); });
      await waitFor(find.text('症状（必須）'));
      await tester.enterText(find.byType(TextField), '合成テストの症状入力です');
      await tester.ensureVisible(find.text('頭'));
      await tester.tap(
        find
            .ancestor(of: find.text('頭'), matching: find.byType(CheckboxListTile))
            .first,
      );
      await tester.pump();
      await tester.ensureVisible(find.text('左膝'));
      await tester.tap(
        find
            .ancestor(
              of: find.text('左膝'),
              matching: find.byType(CheckboxListTile),
            )
            .first,
      );
      await tester.pump();
      await tester.ensureVisible(find.text('症状を保存'));
      await tester.runAsync(() async { await tester.tap(find.text('症状を保存')); });
      // 保存後は IntakeQuestionFlow が起動し、BE の next-question へ実接続して
      // 対話ループへ入る（P-013/P-014）。導入文言＋実 API 由来の最初の質問
      // （常に「答えたくない」を伴う）が描画されることで、保存成功と対話接続を確認。
      await waitFor(find.text('症状を保存しました。続けて質問にお答えください。'));
      final persistedIntakeMatches = client.details.any(
        (detail) =>
            detail['status'] == 'questioning' &&
            detail['initialSymptomText'] == '合成テストの症状入力です' &&
            detail['bodyLocations'] is List &&
            (detail['bodyLocations'] as List).toSet().containsAll(
              ['head', 'left_knee'],
            ) &&
            (detail['bodyLocations'] as List).length == 2,
      );
      expect(
        persistedIntakeMatches,
        isTrue,
        reason: 'Saved intake details were not confirmed by the API response',
      );
      await waitFor(find.text('答えたくない'));
      await tester.tap(find.text('ログアウト'));
      await tester.pump();
      expect(find.text('症状を保存しました。続けて質問にお答えください。'), findsNothing);
      expect(find.text('ログイン'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    } finally { httpClient.close(force: true); await changes.close(); }
  }, skip: !enabled);
}
