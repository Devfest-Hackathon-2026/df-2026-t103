import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

void main() {
  testWidgets('delayed session A start result cannot leak its facility code into session B', (tester) async {
    final delayedA = Completer<http.Response>();
    final startedA = Completer<void>();
    final changes = StreamController<void>.broadcast(sync: true);
    var epoch = Object();
    var token = 'token-A';
    final observed = <String>[];
    http.Response json(Object body) => http.Response(jsonEncode(body), 200,
      headers: {'content-type': 'application/json; charset=utf-8'});
    final client = MockClient((request) async {
      observed.add('${request.url.path}:${request.headers['authorization']}');
      switch (request.url.path) {
        case '/v1/me':
          return json({'accountStatus': 'active', 'emailVerified': true, 'profileComplete': true, 'requiredConsents': {'current': true}});
        case '/v1/me/synthetic-demo':
          expect(request.headers['authorization'], 'Bearer token-A');
          startedA.complete();
          return delayedA.future;
        case '/v1/questionnaires':
          expect(request.headers['authorization'], 'Bearer token-B');
          return json({'questionnaires': [{'questionnaireId': 'questionnaire-B'}]});
        case '/v1/questionnaires/questionnaire-B':
          expect(request.headers['authorization'], 'Bearer token-B');
          return json({'questionnaireId': 'questionnaire-B', 'revision': {'versionNumber': 1}});
        default:
          fail('Unexpected synthetic request path');
      }
    });
    addTearDown(client.close);
    addTearDown(changes.close);
    await tester.pumpWidget(MaterialApp(home: PublicPatientScreen(
      api: PublicPatientApi(origin: 'https://api.example.test', client: client,
        tokens: () async => (auth: token, appCheck: 'synthetic'), session: () => epoch),
      signIn: (_, _) async {}, signOut: () async {}, resetPassword: (_) async {}, changes: changes.stream,
    )));
    Future<void> tap(String label, {bool settle = true}) async {
      await tester.ensureVisible(find.text(label));
      await tester.tap(find.text(label));
      if (settle) {
        await tester.pumpAndSettle();
      } else {
        await tester.pump(const Duration(milliseconds: 300));
      }
    }
    await tap('ログイン');
    await tap('合成デモを開始', settle: false);
    await tap('架空情報のみで開始', settle: false);
    expect(startedA.isCompleted, isTrue);
    // Change BOTH the identity epoch and credential, not merely the UI stream.
    epoch = Object();
    token = 'token-B';
    changes.add(null);
    await tester.pumpAndSettle();
    await tap('ログイン');
    delayedA.complete(json({'facilityId': 'synthetic-session-A', 'syntheticRecipient': true,
      'verificationStatus': 'pending', 'mode': 'storage_only', 'hospitalViewing': 'unconfirmed'}));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('症状（1〜1000文字）')), findsNothing);
    await tap('過去の問診票を見る');
    await tap('確定済み問診票');
    final field = tester.widget<TextField>(find.byKey(const ValueKey('施設コード')));
    expect(field.controller!.text, isEmpty);
    expect(field.readOnly, isFalse);
    expect(find.textContaining('synthetic-session-A'), findsNothing);
    expect(observed, contains('/v1/me/synthetic-demo:Bearer token-A'));
    expect(observed, contains('/v1/questionnaires:Bearer token-B'));
  });

  for (final outcome in ['stored', 'history', 'disabled', 'invalid', 'real-detail', 'other-detail', 'cancel', 'auth-change']) {
    testWidgets('explicit synthetic demo: $outcome', (tester) async {
      var posts = 0, revision = 1;
      var status = 'draft';
      final sends = <Map<String, dynamic>>[];
      final changes = StreamController<void>();
      addTearDown(changes.close);
      final epoch = Object();
      final client = MockClient((request) async {
        Object response;
        var code = 200;
        switch (request.url.path) {
          case '/v1/me':
            response = {'accountStatus': 'active', 'emailVerified': true, 'profileComplete': true, 'requiredConsents': {'current': true}};
          case '/v1/me/synthetic-demo':
            posts++;
            expect(request.method, 'POST');
            expect(jsonDecode(request.body), {'syntheticDataOnly': true});
            if (outcome == 'auth-change') changes.add(null);
            response = {'facilityId': 'synthetic-from-api', 'syntheticRecipient': true,
              'verificationStatus': outcome == 'invalid' ? 'verified' : 'pending',
              'mode': 'storage_only', 'hospitalViewing': 'unconfirmed'};
            if (outcome == 'disabled') { response = {'error': {'code': 'NOT_FOUND'}}; code = 404; }
          case '/v1/intakes':
            response = {'intakeId': 'intake'};
          case '/v1/intakes/intake/symptoms':
            status = 'review'; revision = 2; response = {};
          case '/v1/intakes/intake':
            response = {'revision': revision, 'status': status, 'questions': [], 'answers': []};
          case '/v1/intakes/intake/summary':
            revision++;
            response = {'intakeRevision': revision, 'summary': {'chiefComplaint': {'value': '合成症状'}}};
          case '/v1/intakes/intake/finalize':
            response = {'questionnaireId': 'questionnaire', 'questionnaireRevision': 1};
          case '/v1/questionnaires':
            response = {'questionnaires': [{'questionnaireId': 'questionnaire'}]};
          case '/v1/questionnaires/questionnaire':
            response = {'questionnaireId': 'questionnaire', 'revision': {'versionNumber': 1}};
          case '/v1/facilities/synthetic-from-api':
            response = {'facilityId': outcome == 'other-detail' ? 'other' : 'synthetic-from-api',
              'displayName': 'API専用合成施設', 'verificationStatus': outcome == 'real-detail' ? 'verified' : 'pending',
              'syntheticRecipient': outcome != 'real-detail', 'syntheticStorageOnly': true, 'receivingEnabled': true};
          case '/v1/public/legal-documents':
            response = {'documents': {'hospital_disclosure': {'version': 'v1', 'documentHash': 'hash'}}};
          case '/v1/deliveries':
            sends.add(jsonDecode(request.body) as Map<String, dynamic>);
            response = {'deliveryId': 'delivery'};
          case '/v1/deliveries/delivery':
            response = {'status': 'delivered'};
          default:
            fail('Unexpected API path ${request.url.path}');
        }
        return http.Response(jsonEncode(response), code, headers: {'content-type': 'application/json; charset=utf-8'});
      });
      addTearDown(client.close);
      await tester.pumpWidget(MaterialApp(home: PublicPatientScreen(
        api: PublicPatientApi(origin: 'https://api.example.test', client: client,
          tokens: () async => (auth: 'synthetic', appCheck: 'synthetic'), session: () => epoch),
        signIn: (_, _) async {}, signOut: () async {}, resetPassword: (_) async {}, changes: changes.stream,
      )));
      Future<void> tap(String label) async {
        await tester.ensureVisible(find.text(label));
        await tester.tap(find.text(label));
        if (label == '合成デモを開始') {
          // The guarded operation stays busy until the confirmation dialog closes.
          await tester.pump(const Duration(milliseconds: 300));
        } else {
          await tester.pumpAndSettle();
        }
      }
      await tap('ログイン');
      expect(posts, 0); // ordinary login never provisions a facility
      if (outcome == 'history') {
        await tap('過去の問診票を見る');
        await tap('確定済み問診票');
        await tester.enterText(find.byKey(const ValueKey('施設コード')), 'synthetic-from-api');
        await tap('施設を確認');
      } else {
        await tap('合成デモを開始');
        expect(posts, 0); // opening explanation is not opt-in
        if (outcome == 'cancel') {
          await tap('戻る');
          expect(posts, 0);
          return;
        }
        await tap('架空情報のみで開始');
        expect(posts, 1);
        if (['disabled', 'invalid', 'auth-change'].contains(outcome)) {
          expect(find.byKey(const ValueKey('症状（1〜1000文字）')), findsNothing);
          expect(sends, isEmpty);
          return;
        }
        await tester.enterText(find.byKey(const ValueKey('症状（1〜1000文字）')), '合成症状');
        await tap('保存して質問へ進む');
        await tap('問診の内容を確認しました');
        await tap('この内容で問診票を確定');
      }
      final field = tester.widget<TextField>(find.byKey(const ValueKey('施設コード')));
      expect(field.controller!.text, 'synthetic-from-api');
      expect(field.readOnly, isTrue);
      if (outcome != 'stored' && outcome != 'history') {
        expect(find.text('同意した施設へ送信'), findsNothing);
        expect(sends, isEmpty);
        return;
      }
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '同意した施設へ送信')).onPressed, isNull);
      await tap('「API専用合成施設」へ、この問診票と選択した情報を送信することに同意します');
      await tap('同意した施設へ送信');
      expect(sends.single['facilityId'], 'synthetic-from-api');
      expect((sends.single['consent'] as Map)['accepted'], isTrue);
      expect(find.text('合成デモの送信を保存しました。病院側閲覧・受領は未確認です。'), findsOneWidget);
      expect(find.text('施設の受信箱へ届きました'), findsNothing);
    });
  }
}
