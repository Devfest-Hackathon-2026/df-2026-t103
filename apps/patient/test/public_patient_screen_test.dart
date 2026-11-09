import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

Map<String, dynamic> _question(String id, int index) => {
  'questionId': id,
  'questionRevision': 1,
  'stepIndex': index,
  'questionText': '合成の質問$id',
  'options': [
    {'code': 'YES', 'label': 'はい'},
  ],
};

class _IntakeBackend {
  final answers = <Map<String, dynamic>>[];
  final postedAnswers = <Map<String, dynamic>>[];
  int revision = 1;
  int nextQuestion = 1;
  bool symptomsSaved = false;
  bool loseFirstAnswerResponse = false;
  int lostAnswerResponseStatus = 503;
  bool rejectAnswer = false;
  bool failNextIntakeGet = false;
  Object? intakeAnswersOverride;
  Map<String, dynamic> intakeOverride = {};
  Object sessionEpoch = Object();
  int sessionReads = 0;
  int? switchSessionAtRead;
  Completer<void>? intakeGetGate;
  Completer<void>? nextQuestionGate;
  int answerPosts = 0;
  int answerWrites = 0;
  final answerKeys = <String?>[];
  final answerBodies = <Map<String, dynamic>>[];
  final idempotentAnswers = <String, Map<String, dynamic>>{};

  http.Response json(Map<String, dynamic> value, [int status = 200]) =>
      http.Response(
        jsonEncode(value),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  http.Client client() => MockClient((request) async {
    final path = request.url.path;
    if (path == '/v1/me') {
      return json({
        'accountStatus': 'active',
        'emailVerified': true,
        'profileComplete': true,
        'requiredConsents': {'current': true},
      });
    }
    if (path == '/v1/intakes' && request.method == 'POST') {
      return json({'intakeId': 'intake-1'});
    }
    if (path == '/v1/intakes/intake-1/symptoms') {
      symptomsSaved = true;
      revision = 2;
      return json({'ok': true});
    }
    if (path == '/v1/intakes/intake-1' && request.method == 'GET') {
      if (failNextIntakeGet) {
        failNextIntakeGet = false;
        return json({'error': 'synthetic read failure'}, 503);
      }
      await intakeGetGate?.future;
      final questionId = nextQuestion == 1 ? 'q1' : 'q2';
      final current = _question(questionId, nextQuestion - 1)
        ..['status'] = answers.any((a) => a['questionId'] == questionId)
            ? 'answered'
            : 'active';
      return json({
        'intakeId': 'intake-1',
        'status': symptomsSaved ? 'questioning' : 'draft',
        'revision': revision,
        'currentQuestionId': symptomsSaved ? questionId : null,
        'questions': symptomsSaved ? [current] : <dynamic>[],
        'answers': intakeAnswersOverride ?? answers,
        ...intakeOverride,
      });
    }
    if (path == '/v1/intakes/intake-1/next-question') {
      await nextQuestionGate?.future;
      nextQuestion++;
      return json({
        'intakeId': 'intake-1',
        'intakeRevision': revision,
        'question': _question('q$nextQuestion', nextQuestion - 1),
      });
    }
    if (path == '/v1/intakes/intake-1/answers') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      answerPosts++;
      postedAnswers.add(body);
      answerKeys.add(request.headers['idempotency-key']);
      answerBodies.add(Map<String, dynamic>.from(body));
      if (rejectAnswer) {
        return json({
          'error': {
            'code': 'REVISION_CONFLICT',
            'retryable': false,
            'message': 'synthetic revision conflict',
          },
        }, 409);
      }
      final key = request.headers['idempotency-key']!;
      final replay = idempotentAnswers[key];
      if (replay == null) {
        final result = {
          'answerId': body['questionId'],
          'intakeRevision': revision + 1,
        };
        idempotentAnswers[key] = result;
        answers.add({
          'answerId': body['questionId'],
          ...body,
          'stepIndex': 0,
          'freeText': body['freeText'],
          'answeredAt': 'now',
          'updatedAt': 'now',
        });
        revision++;
        answerWrites++;
      }
      if (loseFirstAnswerResponse) {
        loseFirstAnswerResponse = false;
        return json({
          'error': {
            'code': lostAnswerResponseStatus == 409
                ? 'IDEMPOTENCY_IN_PROGRESS'
                : 'UPSTREAM_UNAVAILABLE',
            'retryable': true,
            'message': 'synthetic response loss',
          },
        }, lostAnswerResponseStatus);
      }
      return json(replay ?? idempotentAnswers[key]!);
    }
    fail('Unexpected request: ${request.method} $path');
  });
}

Future<void> _openQuestion(
  WidgetTester tester,
  _IntakeBackend backend, {
  Stream<void> changes = const Stream<void>.empty(),
  DateTime Function()? clock,
}) async {
  final client = backend.client();
  addTearDown(client.close);
  await tester.pumpWidget(
    MaterialApp(
      home: PublicPatientScreen(
        api: PublicPatientApi(
          origin: 'https://api.example.test',
          client: client,
          tokens: () async => (auth: 'synthetic', appCheck: 'synthetic'),
          session: () {
            backend.sessionReads++;
            if (backend.sessionReads == backend.switchSessionAtRead) {
              backend.sessionEpoch = Object();
            }
            return backend.sessionEpoch;
          },
          clock: clock,
        ),
        signIn: (_, _) async {},
        signOut: () async {},
        resetPassword: (_) async {},
        changes: changes,
      ),
    ),
  );
  Future<void> tap(String label) async {
    await tester.ensureVisible(find.text(label));
    await tester.tap(find.text(label));
    await tester.pumpAndSettle();
  }

  await tap('ログイン');
  await tap('新しい問診をはじめる');
  await tester.enterText(find.byKey(const ValueKey('症状（1〜1000文字）')), '合成症状');
  await tap('保存して質問へ進む');
  expect(find.text('合成の質問q1'), findsOneWidget);
}

void main() {
  testWidgets(
    'posts optional freeText separately and clears it on question change',
    (tester) async {
      final backend = _IntakeBackend();
      await _openQuestion(tester, backend);
      await tester.enterText(
        find.byKey(const ValueKey('回答（任意）')),
        '  昨夜から痛みます  ',
      );
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(backend.postedAnswers.single, {
        'questionId': 'q1',
        'questionRevision': 1,
        'selectedCodes': ['YES'],
        'answerState': 'answered',
        'freeText': '  昨夜から痛みます  ',
        'expectedIntakeRevision': 2,
      });
      expect(find.text('合成の質問q2'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('回答（任意）')))
            .controller!
            .text,
        isEmpty,
      );
    },
  );

  for (final status in [409, 503]) {
    testWidgets('retries same answer after uncertain HTTP $status', (
      tester,
    ) async {
      final backend = _IntakeBackend()
        ..loseFirstAnswerResponse = true
        ..lostAnswerResponseStatus = status;
      await _openQuestion(tester, backend);
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(backend.answerPosts, 1);
      expect(find.textContaining('保存結果を確認できません'), findsOneWidget);
      expect(find.text('同じ回答を再送して確認'), findsOneWidget);
      await tester.ensureVisible(find.text('同じ回答を再送して確認'));
      await tester.tap(find.text('同じ回答を再送して確認'));
      await tester.pumpAndSettle();
      expect(backend.answerPosts, 2);
      expect(backend.answerWrites, 1);
      expect(backend.answerKeys.first, isNotEmpty);
      expect(backend.answerKeys[1], backend.answerKeys.first);
      expect(backend.answerBodies[1], backend.answerBodies.first);
      expect(backend.nextQuestion, 2);
      expect(find.textContaining('通信結果を確認できません'), findsNothing);
      expect(find.text('合成の質問q2'), findsOneWidget);
    });
  }

  testWidgets('does not retry a definitive answer revision conflict', (
    tester,
  ) async {
    final backend = _IntakeBackend()..rejectAnswer = true;
    await _openQuestion(tester, backend);
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    expect(backend.answerPosts, 1);
    expect(backend.answerWrites, 0);
    expect(find.text('同じ回答を再送して確認'), findsNothing);
    expect(find.text('保存状態を再確認'), findsOneWidget);
  });

  testWidgets('multiple taps send one answer operation', (tester) async {
    final backend = _IntakeBackend();
    await _openQuestion(tester, backend);
    backend.intakeGetGate = Completer<void>();
    await tester.tap(find.text('はい'));
    await tester.pump();
    await tester.tap(find.text('はい'));
    await tester.pump();
    backend.intakeGetGate!.complete();
    await tester.pumpAndSettle();
    expect(backend.answerPosts, 1);
    expect(backend.answerWrites, 1);
  });

  testWidgets('does not retry an uncertain answer after the 24-hour TTL', (
    tester,
  ) async {
    final backend = _IntakeBackend()..loseFirstAnswerResponse = true;
    var now = DateTime.utc(2026, 1, 1);
    await _openQuestion(tester, backend, clock: () => now);
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    expect(backend.answerPosts, 1);
    now = now.add(const Duration(hours: 24));
    await tester.ensureVisible(find.text('同じ回答を再送して確認'));
    await tester.tap(find.text('同じ回答を再送して確認'));
    await tester.pumpAndSettle();
    expect(backend.answerPosts, 1);
    expect(find.text('同じ回答を再送して確認'), findsNothing);
    expect(
      find.text('回答の再送可能期間が終了しました。問診を続けず、サポートへお問い合わせください。'),
      findsOneWidget,
    );
  });

  testWidgets('session change discards an uncertain answer retry key', (
    tester,
  ) async {
    final backend = _IntakeBackend()..loseFirstAnswerResponse = true;
    final changes = StreamController<void>();
    addTearDown(changes.close);
    await _openQuestion(tester, backend, changes: changes.stream);
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    expect(backend.answerPosts, 1);
    changes.add(null);
    await tester.pumpAndSettle();
    expect(find.text('同じ回答を再送して確認'), findsNothing);
    expect(find.text('合成の質問q1'), findsNothing);
    expect(backend.answerPosts, 1);
  });

  testWidgets('limits freeText by UTF-16 code units and omits it for skip', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    await _openQuestion(tester, backend);
    final answerField = find.byKey(const ValueKey('回答（任意）'));
    await tester.enterText(answerField, '😀' * 1001);
    final value = tester.widget<TextField>(answerField).controller!.text;
    expect(value.length, 2000);
    expect(value, '😀' * 1000);
    await tester.tap(find.text('答えたくない'));
    await tester.pumpAndSettle();

    expect(backend.postedAnswers.single['answerState'], 'skipped');
    expect(backend.postedAnswers.single.containsKey('freeText'), isFalse);
  });

  for (final malformed in [
    {'answers': <String, dynamic>{}},
    {
      'answers': [
        <String, dynamic>{'questionId': 'q1'},
      ],
    },
    {
      'answers': [
        {
          'answerId': 'a1',
          'questionId': 'q1',
          'questionRevision': '1',
          'stepIndex': 0,
          'selectedCodes': <String>[],
          'freeText': null,
          'answerState': 'answered',
          'answeredAt': 'now',
          'updatedAt': 'now',
        },
      ],
    },
  ]) {
    testWidgets('malformed preflight answers fail closed: ${malformed.keys}', (
      tester,
    ) async {
      final backend = _IntakeBackend();
      await _openQuestion(tester, backend);
      backend.intakeAnswersOverride = malformed['answers'];
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(backend.answerPosts, 0);
      expect(find.text('合成の質問q1'), findsOneWidget);
      expect(find.textContaining('通信結果を確認できません'), findsOneWidget);
    });
  }

  testWidgets(
    'uncertain save requires explicit same-key retry and does not claim success before it',
    (tester) async {
      final backend = _IntakeBackend()..loseFirstAnswerResponse = true;
      await _openQuestion(tester, backend);
      await tester.enterText(find.byKey(const ValueKey('回答（任意）')), '合成の補足');
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(backend.answerPosts, 1);
      expect(find.text('合成の質問q1'), findsOneWidget);
      expect(find.textContaining('サービスの準備状況を確認できません'), findsOneWidget);
      expect(find.textContaining('保存結果を確認できません'), findsOneWidget);
      expect(find.text('同じ回答を再送して確認'), findsOneWidget);
      await tester.pumpAndSettle();
      expect(backend.answerPosts, 1);
      expect(find.text('合成の質問q2'), findsNothing);
      await tester.ensureVisible(find.text('同じ回答を再送して確認'));
      await tester.tap(find.text('同じ回答を再送して確認'));
      await tester.pumpAndSettle();
      expect(backend.answerPosts, 2);
      expect(backend.answerWrites, 1);
      expect(find.text('合成の質問q2'), findsOneWidget);
    },
  );

  testWidgets(
    'preflight GET failure permits explicit retry but never treats another device answer as ours',
    (tester) async {
      final backend = _IntakeBackend();
      await _openQuestion(tester, backend);
      backend.failNextIntakeGet = true;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      expect(backend.answerPosts, 0);
      expect(find.text('保存状態を再確認'), findsOneWidget);

      backend.answers.add({
        'questionId': 'q1',
        'questionRevision': 1,
        'selectedCodes': ['NO'],
        'answerState': 'answered',
        'answerId': 'q1',
        'stepIndex': 0,
        'freeText': null,
        'answeredAt': 'now',
        'updatedAt': 'now',
      });
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      expect(backend.answerPosts, 0);
      expect(find.text('合成の質問q1'), findsOneWidget);
      expect(find.text('合成の質問q2'), findsNothing);
      expect(find.textContaining('現在の利用状態では操作できません'), findsOneWidget);
    },
  );

  for (final override in [
    {'status': 'review'},
    {'currentQuestionId': 'q2'},
    {
      'questions': [
        {..._question('q1', 0), 'status': 'answered'},
      ],
    },
    {'revision': 3},
  ]) {
    testWidgets('does not POST against inconsistent intake GET: $override', (
      tester,
    ) async {
      final backend = _IntakeBackend();
      await _openQuestion(tester, backend);
      backend.intakeOverride = override;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(backend.answerPosts, 0);
      expect(find.text('合成の質問q1'), findsOneWidget);
    });
  }

  testWidgets('does not POST when session changes after preflight GET', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    await _openQuestion(tester, backend);
    // answer(): captures owner, then the GET reads its owner, checks after
    // token refresh, checks after response, and finally compares the captured
    // owner before POST. Change identity at that last check without notifying
    // the widget's change stream.
    backend.sessionReads = 0;
    backend.switchSessionAtRead = 5;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();

    expect(backend.answerPosts, 0);
    expect(find.text('合成の質問q1'), findsOneWidget);
  });

  testWidgets('discards delayed next-question GET after session change', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    final changes = StreamController<void>();
    addTearDown(changes.close);
    await _openQuestion(tester, backend, changes: changes.stream);
    backend.intakeGetGate = Completer<void>();
    await tester.tap(find.text('保存状態を再確認'));
    await tester.pump();
    changes.add(null);
    await tester.pump();
    backend.intakeGetGate!.complete();
    await tester.pumpAndSettle();

    expect(find.text('合成の質問q1'), findsNothing);
    expect(
      find.text('発行されたアカウントでログインしてください。未完了の登録手続きはログイン後に案内します。'),
      findsOneWidget,
    );
  });

  testWidgets('discards delayed next-question POST after session change', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    final changes = StreamController<void>();
    addTearDown(changes.close);
    await _openQuestion(tester, backend, changes: changes.stream);
    backend.nextQuestionGate = Completer<void>();
    await tester.tap(find.text('はい'));
    await tester.pump();
    // Let the answer POST complete and the following next-question POST block.
    await tester.pump();
    changes.add(null);
    await tester.pump();
    backend.nextQuestionGate!.complete();
    await tester.pumpAndSettle();

    expect(find.text('合成の質問q2'), findsNothing);
    expect(
      find.text('発行されたアカウントでログインしてください。未完了の登録手続きはログイン後に案内します。'),
      findsOneWidget,
    );
  });

  testWidgets('clears freeText and abandons the question on session change', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    final changes = StreamController<void>();
    addTearDown(changes.close);
    await _openQuestion(tester, backend, changes: changes.stream);
    await tester.enterText(find.byKey(const ValueKey('回答（任意）')), '合成の入力');

    changes.add(null);
    await tester.pumpAndSettle();

    expect(find.text('合成の質問q1'), findsNothing);
    expect(
      find.text('発行されたアカウントでログインしてください。未完了の登録手続きはログイン後に案内します。'),
      findsOneWidget,
    );
  });

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
