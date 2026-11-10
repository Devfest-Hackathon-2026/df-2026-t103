import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

class _LiveBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

// Only inject transport loss after the REAL endpoint returned its committed
// result. All application calls and all retries still go to the real backend.
class _LoseFirstStartResponse extends http.BaseClient {
  final inner = http.Client();
  final facilityIds = <String>[];
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await inner.send(request);
    if (request.method != 'POST' || request.url.path != '/v1/me/synthetic-demo') {
      return response;
    }
    final bytes = await response.stream.toBytes();
    if (response.statusCode == 200) {
      facilityIds.add((jsonDecode(utf8.decode(bytes)) as Map)['facilityId'] as String);
      if (facilityIds.length == 1) throw http.ClientException('Synthetic response loss after commit');
    }
    return http.StreamedResponse(Stream.value(bytes), response.statusCode, headers: response.headers);
  }
  @override
  void close() => inner.close();
}

void _requireLoopback(String origin) {
  final uri = Uri.parse(origin);
  if (uri.scheme != 'http' || !{'127.0.0.1', 'localhost'}.contains(uri.host) ||
      !uri.hasPort || uri.userInfo.isNotEmpty || uri.path.isNotEmpty || uri.hasQuery || uri.hasFragment) {
    throw StateError('UI E2E requires explicit loopback emulator origins');
  }
}

void main() {
  const enabled = bool.fromEnvironment('RUN_SYNTHETIC_DEMO_UI_INTEGRATION');
  if (enabled) _LiveBinding();
  testWidgets('Flutter real registration → verification → profile → opt-in retry → intake → consent → storage-only display', (tester) async {
    tester.view.physicalSize = const Size(1200, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const apiOrigin = String.fromEnvironment('PUBLIC_REGISTRATION_API_ORIGIN');
    const authOrigin = String.fromEnvironment('PUBLIC_REGISTRATION_AUTH_ORIGIN');
    const firestoreOrigin = String.fromEnvironment('PUBLIC_REGISTRATION_FIRESTORE_ORIGIN');
    for (final origin in [apiOrigin, authOrigin, firestoreOrigin]) { _requireLoopback(origin); }
    final client = _LoseFirstStartResponse();
    final changes = StreamController<void>.broadcast(sync: true);
    var epoch = Object();
    String? token;
    final email = 'synthetic-ui-${DateTime.now().microsecondsSinceEpoch}@example.test';
    const password = 'Synthetic-registration-123';
    Future<Map<String, dynamic>> authPost(String method, Map<String, Object?> body) async {
      final response = await client.post(Uri.parse('$authOrigin/identitytoolkit.googleapis.com/v1/$method?key=demo-key'),
        headers: {'content-type': 'application/json'}, body: jsonEncode(body));
      expect(response.statusCode, 200); // Never include credentials or bodies in failure output.
      return jsonDecode(response.body) as Map<String, dynamic>;
    }
    Future<void> refreshToken() async {
      token = (await authPost('accounts:signInWithPassword', {'email': email, 'password': password, 'returnSecureToken': true}))['idToken'] as String;
    }
    final api = PublicPatientApi(origin: apiOrigin, client: client, session: () => epoch,
      tokens: () async => (auth: token, appCheck: 'local-emulator-only'));
    Future<void> waitFor(bool Function() ready) async {
      for (var i = 0; i < 400; i++) {
        await tester.pump();
        if (ready()) return;
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      }
      fail('Real UI E2E did not reach the expected state');
    }
    Future<void> tap(String label, {bool opensDialog = false, Finder? finder}) async {
      final target = finder ?? find.text(label);
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.ensureVisible(target);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.runAsync(() => tester.tap(target));
      await tester.pump();
      if (opensDialog) {
        await tester.pump(const Duration(milliseconds: 300));
      } else {
        await waitFor(() => find.byType(LinearProgressIndicator).evaluate().isEmpty);
      }
    }
    Future<int> createdCount() async {
      final response = await tester.runAsync(() => client.get(Uri.parse(
        '$firestoreOrigin/v1/projects/demo-mmr-dev/databases/(default)/documents/syntheticDemoProvisioning/selfService'),
        headers: {'authorization': 'Bearer owner'})); // Local emulator Admin metadata only.
      expect(response!.statusCode, 200);
      return int.parse(((jsonDecode(response.body) as Map)['fields'] as Map)['createdCount']['integerValue'] as String);
    }
    try {
      debugPrintSynchronously('synthetic-ui-mount');
      await tester.pumpWidget(MaterialApp(home: PublicPatientScreen(
        api: api, changes: changes.stream,
        signIn: (submittedEmail, submittedPassword) async {
          expect(submittedEmail, email);
          expect(submittedPassword == password, isTrue);
          await refreshToken(); epoch = Object(); changes.add(null);
        },
        signOut: () async { token = null; epoch = Object(); changes.add(null); },
        resetPassword: (_) async => throw StateError('No real email allowed'),
        sendEmailVerification: () async { await authPost('accounts:sendOobCode', {'requestType': 'VERIFY_EMAIL', 'idToken': token}); },
        refreshEmailVerification: () async {
          await refreshToken();
          final user = await authPost('accounts:lookup', {'idToken': token});
          return ((user['users'] as List).single as Map)['emailVerified'] == true;
        },
      )));
      debugPrintSynchronously('synthetic-ui-registration');
      await tap('初めてご利用の方（新規登録）');
      await tester.enterText(find.byKey(const ValueKey('メールアドレス')), email);
      await tester.enterText(find.byKey(const ValueKey('パスワード（8〜128文字）')), password);
      for (final label in ['利用規約に同意する', 'プライバシーについてに同意する', '健康情報の取得についてに同意する']) {
        await tap(label);
      }
      await tap('同意してアカウントを登録');
      // The session-change notification clears the busy indicator before the
      // asynchronous verification refresh finishes. Wait for the actual view,
      // not merely the absence of a progress indicator.
      await waitFor(() => find.text('メールアドレスの確認').evaluate().length == 1);
      expect(find.text('メールアドレスの確認'), findsOneWidget);
      expect(client.facilityIds, isEmpty);
      debugPrintSynchronously('synthetic-ui-verification');
      await tap('確認メールを送信');
      await tester.runAsync(() async {
        final response = await client.get(Uri.parse('$authOrigin/emulator/v1/projects/demo-mmr-dev/oobCodes'));
        expect(response.statusCode, 200);
        final codes = ((jsonDecode(response.body) as Map)['oobCodes'] as List).cast<Map>();
        final code = codes.singleWhere((entry) => entry['email'] == email && entry['requestType'] == 'VERIFY_EMAIL');
        await authPost('accounts:update', {'oobCode': code['oobCode']});
      });
      await tap('確認状況を更新');
      expect(find.text('プロフィール登録'), findsOneWidget);
      debugPrintSynchronously('synthetic-ui-profile');
      for (final entry in {
        '姓': '合成', '名': '審査', '姓（カタカナ）': 'ゴウセイ', '名（カタカナ）': 'シンサ',
        '生年月日（例：1990-01-01）': '1990-01-01', '電話番号': '09000000000', '郵便番号（7桁）': '1000001',
        '都道府県（例：東京都）': '東京都', '市区町村': '架空市', '町名・番地': '架空1-1',
      }.entries) {
        await tester.enterText(find.byKey(ValueKey(entry.key)), entry.value);
      }
      await tap('プロフィールを保存して問診へ');
      expect(find.text('合成デモを開始'), findsOneWidget);
      expect(client.facilityIds, isEmpty);
      debugPrintSynchronously('synthetic-ui-start-response-loss');
      await tap('合成デモを開始', opensDialog: true);
      await tap('架空情報のみで開始');
      expect(client.facilityIds, hasLength(1));
      expect(find.byKey(const ValueKey('症状（1〜1000文字）')), findsNothing);
      expect(await createdCount(), 1);
      debugPrintSynchronously('synthetic-ui-start-retry');
      await tap('合成デモを開始', opensDialog: true);
      await tap('架空情報のみで開始');
      expect(client.facilityIds, hasLength(2));
      expect(client.facilityIds[1], client.facilityIds[0]);
      expect(await createdCount(), 1);
      debugPrintSynchronously('synthetic-ui-intake');
      await tester.enterText(find.byKey(const ValueKey('症状（1〜1000文字）')), '合成デモ：1週間頭が痛い');
      await tap('保存して質問へ進む');
      var answers = 0;
      while (find.text('問診の内容を確認しました').evaluate().isEmpty && answers < 20) {
        await tap('わからない', finder: find.widgetWithText(FilledButton, 'わからない'));
        answers++;
      }
      expect(answers, greaterThan(0));
      expect(find.text('問診の内容を確認しました'), findsOneWidget);
      debugPrintSynchronously('synthetic-ui-finalize');
      await tap('問診の内容を確認しました');
      await tap('この内容で問診票を確定');
      final field = tester.widget<TextField>(find.byKey(const ValueKey('施設コード')));
      expect(field.controller!.text, client.facilityIds.first);
      expect(field.readOnly, isTrue);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '同意した施設へ送信')).onPressed, isNull);
      debugPrintSynchronously('synthetic-ui-consent');
      final facility = await tester.runAsync(() => api.request('GET', '/facilities/${client.facilityIds.first}'));
      expect(facility!['syntheticRecipient'], isTrue);
      await tap('「${facility['displayName']}」へ、この問診票と選択した情報を送信することに同意します');
      debugPrintSynchronously('synthetic-ui-storage');
      await tap('同意した施設へ送信');
      expect(find.text('合成デモの送信を保存しました。病院側閲覧・受領は未確認です。'), findsOneWidget);
      expect(find.text('施設の受信箱へ届きました'), findsNothing);
      expect(await createdCount(), 1);
      debugPrintSynchronously('synthetic-ui-logout');
      await tap('ログアウト');
      expect(find.text('合成デモ中：架空情報のみ。送信保存まで（病院側閲覧は未確認）。'), findsNothing);
      debugPrintSynchronously('synthetic-ui-complete');
    } catch (error) {
      // Fixed categories only: never print exception text, stack or API data.
      debugPrintSynchronously(error is TestFailure ? 'synthetic-ui-error-assertion'
          : error is TimeoutException ? 'synthetic-ui-error-timeout'
          : error is StateError ? 'synthetic-ui-error-state'
          : error is FormatException ? 'synthetic-ui-error-format'
          : error is http.ClientException ? 'synthetic-ui-error-transport'
          : 'synthetic-ui-error-other');
      rethrow;
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await changes.close();
      client.close();
    }
  }, skip: !enabled, timeout: const Timeout(Duration(minutes: 3)));
}
