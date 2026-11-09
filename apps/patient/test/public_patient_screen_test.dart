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
    {'code': 'NO', 'label': 'いいえ'},
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
  Map<String, dynamic>? answerResponseOverride;
  bool failNextIntakeGet = false;
  bool finishAfterNextQuestion = false;
  bool rejectAnswerPatch = false;
  int? answerPatchRejectStatus;
  bool concurrentIdenticalAnswerPatch = false;
  bool loseAnswerPatchResponse = false;
  String? statusOverride;
  bool reviewAfterAnswer = false;
  List<String>? selectedCodesAfterAnswer;
  final questions = <Map<String, dynamic>>[];
  final invalidatedQuestions = <String>{};
  final answerPatches = <Map<String, dynamic>>[];
  final requestPaths = <String>[];
  Object? intakeAnswersOverride;
  Map<String, dynamic> intakeOverride = {};
  Object sessionEpoch = Object();
  int sessionReads = 0;
  int? switchSessionAtRead;
  Completer<void>? intakeGetGate;
  Completer<void>? nextQuestionGate;
  int answerPosts = 0;
  int answerWrites = 0;
  bool switchSessionOnPatch = false;
  void Function()? onSessionSwitch;
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
    requestPaths.add('${request.method} $path');
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
      final questionId = 'q$nextQuestion';
      final current = _question(questionId, nextQuestion - 1)
        ..['status'] = answers.any((a) => a['questionId'] == questionId)
            ? 'answered'
            : 'active';
      final allQuestions = questions.isEmpty ? [current] : questions;
      return json({
        'intakeId': 'intake-1',
        'status': statusOverride ?? (symptomsSaved ? 'questioning' : 'draft'),
        'revision': revision,
        'currentQuestionId': symptomsSaved ? questionId : null,
        'questions': symptomsSaved ? allQuestions : <dynamic>[],
        'answers': intakeAnswersOverride ?? answers,
        ...intakeOverride,
      });
    }
    if (path == '/v1/intakes/intake-1/next-question') {
      await nextQuestionGate?.future;
      if (finishAfterNextQuestion) {
        return json({
          'intakeId': 'intake-1',
          'intakeRevision': revision,
          'question': null,
        });
      }
      if (invalidatedQuestions.isNotEmpty && nextQuestion < 2) {
        nextQuestion = 2;
      }
      nextQuestion++;
      final generated = _question('q$nextQuestion', nextQuestion - 1)
        ..['status'] = 'active';
      if (invalidatedQuestions.isNotEmpty) {
        questions.add(generated);
        revision++;
      }
      return json({
        'intakeId': 'intake-1',
        'intakeRevision': revision,
        'question': generated,
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
          if (selectedCodesAfterAnswer != null)
            'selectedCodes': selectedCodesAfterAnswer,
          'stepIndex': 0,
          'freeText': body['freeText'],
          'answeredAt': 'now',
          'updatedAt': 'now',
        });
        for (final question in questions.where(
          (q) => q['questionId'] == body['questionId'],
        )) {
          question['status'] = 'answered';
        }
        revision++;
        if (reviewAfterAnswer) statusOverride = 'review';
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
      return json(answerResponseOverride ?? replay ?? idempotentAnswers[key]!);
    }
    if (path == '/v1/intakes/intake-1/answers/q1' &&
        request.method == 'PATCH') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      answerPatches.add(body);
      final currentQuestion = questions.where(
        (item) => item['questionId'] == 'q1',
      );
      if (currentQuestion.length == 1 &&
          body['questionRevision'] !=
              currentQuestion.single['questionRevision']) {
        return json({
          'error': {'code': 'QUESTION_REVISION_CONFLICT'},
        }, 409);
      }
      if (answerPatchRejectStatus != null) {
        return json({
          'error': {'code': 'SYNTHETIC_REJECTION'},
        }, answerPatchRejectStatus!);
      }
      if (rejectAnswerPatch || body['expectedIntakeRevision'] != revision) {
        if (concurrentIdenticalAnswerPatch) {
          concurrentIdenticalAnswerPatch = false;
          final answer = answers.singleWhere(
            (item) => item['questionId'] == 'q1',
          );
          answer['selectedCodes'] = body['selectedCodes'];
          answer['freeText'] = body['freeText'];
          answer['answerState'] = body['answerState'];
          revision++;
        }
        return json({
          'error': {'code': 'REVISION_CONFLICT'},
        }, 409);
      }
      final answer = answers.singleWhere((item) => item['questionId'] == 'q1');
      for (final key in ['selectedCodes', 'freeText', 'answerState']) {
        if (body.containsKey(key)) answer[key] = body[key];
      }
      for (final question in questions.where(
        (q) => (q['stepIndex'] as int) > 0,
      )) {
        question['status'] = 'invalidated';
        invalidatedQuestions.add(question['questionId'] as String);
        answers.removeWhere((a) => a['questionId'] == question['questionId']);
      }
      if (invalidatedQuestions.isNotEmpty) statusOverride = 'questioning';
      revision++;
      if (switchSessionOnPatch) {
        sessionEpoch = Object();
        onSessionSwitch?.call();
      }
      if (loseAnswerPatchResponse) {
        loseAnswerPatchResponse = false;
        return json({
          'error': {'code': 'UPSTREAM_UNAVAILABLE'},
        }, 503);
      }
      return json({'answerId': 'q1', 'intakeRevision': revision});
    }
    if (path == '/v1/intakes/intake-1/summary') {
      revision++;
      statusOverride = 'review';
      return json({
        'summary': {
          'chiefComplaint': {'value': '合成症状'},
        },
        'intakeRevision': revision,
      });
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

  testWidgets('チャット: 症状と過去のQ&Aが会話として積み上がる', (tester) async {
    final backend = _IntakeBackend();
    // 実APIの intake GET は保存済み症状と既出の全質問を返す。テストでも再現する。
    backend.intakeOverride = {'initialSymptomText': '合成症状'};
    backend.questions.addAll([
      {..._question('q1', 0), 'status': 'active'},
      {..._question('q2', 1), 'status': 'active'},
    ]);
    await _openQuestion(tester, backend); // 症状「合成症状」保存→q1表示
    // q1 に回答すると次の質問 q2 がライブ表示になる。
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    expect(find.text('合成の質問q2'), findsOneWidget);
    // 会話トランスクリプトに、入力した症状・回答済みの質問q1・その回答が残る。
    expect(find.text('合成症状'), findsOneWidget);
    expect(find.text('合成の質問q1'), findsOneWidget);
    // q1 の回答「はい」の吹き出しと、q2 の選択肢ボタン「はい」で複数一致する。
    expect(find.text('はい'), findsWidgets);
  });

  testWidgets('review redisplays the saved answer and offers an edit action', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    backend.questions.add({..._question('q1', 0), 'status': 'active'});
    await _openQuestion(tester, backend);
    await tester.enterText(find.byKey(const ValueKey('回答（任意）')), '保存済み補足');
    backend.reviewAfterAnswer = true;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();

    expect(backend.requestPaths, contains('POST /v1/intakes/intake-1/answers'));
    expect(backend.answers, hasLength(1));
    expect(find.text('保存済み補足'), findsOneWidget);
    expect(find.text('保存済みの回答'), findsOneWidget);
    expect(find.text('はい'), findsWidgets);
    expect(find.text('回答を編集'), findsOneWidget);
  });

  testWidgets('edits a saved answer with revision and confirms it by GET', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    backend.questions.addAll([
      {..._question('q1', 0), 'status': 'active'},
      {..._question('q2', 1), 'status': 'active'},
    ]);
    await _openQuestion(tester, backend);
    await tester.enterText(find.byKey(const ValueKey('回答（任意）')), '旧い補足');
    backend.reviewAfterAnswer = true;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('回答を編集').first);
    await tester.tap(find.text('回答を編集').first);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('保存済み回答の補足')), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('保存済み回答の補足')), '新しい補足');
    await tester.tap(find.text('いいえ'));
    await tester.pump();
    await tester.ensureVisible(find.text('編集内容を保存'));
    await tester.tap(find.text('編集内容を保存'));
    await tester.pumpAndSettle();

    expect(backend.answerPatches, hasLength(1));
    expect(backend.answerPatches.single, {
      'questionRevision': 1,
      'selectedCodes': ['NO'],
      'freeText': '新しい補足',
      'answerState': 'answered',
      'expectedIntakeRevision': 4,
    });
    // PATCH increments once; re-asking the invalidated downstream question
    // increments the intake revision again.
    expect(backend.revision, 6);
    expect(backend.invalidatedQuestions, contains('q2'));
    final patchIndex = backend.requestPaths.indexOf(
      'PATCH /v1/intakes/intake-1/answers/q1',
    );
    expect(patchIndex, greaterThanOrEqualTo(0));
    expect(backend.requestPaths[patchIndex + 1], 'GET /v1/intakes/intake-1');
    expect(
      backend.answers.singleWhere(
        (answer) => answer['questionId'] == 'q1',
      )['freeText'],
      '新しい補足',
    );
    expect(find.text('合成の質問q2'), findsNothing);
    expect(find.text('合成の質問q3'), findsOneWidget);
    expect(find.byKey(const ValueKey('保存済み回答の補足')), findsNothing);

    // Simulate the API ending the replacement branch and verify the patient
    // can answer the re-asked question and return to a fresh review summary.
    backend.reviewAfterAnswer = false;
    backend.finishAfterNextQuestion = true;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    expect(find.text('問診の内容を確認しました'), findsOneWidget);
    expect(backend.statusOverride, 'review');
    expect(
      backend.answers.singleWhere(
        (answer) => answer['questionId'] == 'q1',
      )['freeText'],
      '新しい補足',
    );
  });

  testWidgets('free-text edit preserves every saved selected code', (
    tester,
  ) async {
    final backend = _IntakeBackend();
    backend.questions.add({..._question('q1', 0), 'status': 'active'});
    backend.selectedCodesAfterAnswer = ['YES', 'NO'];
    await _openQuestion(tester, backend);
    backend.reviewAfterAnswer = true;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('回答を編集'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('保存済み回答の補足')), '自由文だけ変更');
    await tester.ensureVisible(find.text('編集内容を保存'));
    await tester.tap(find.text('編集内容を保存'));
    await tester.pumpAndSettle();

    expect(backend.answerPatches.single['selectedCodes'], ['YES', 'NO']);
    expect(backend.answers.single['selectedCodes'], ['YES', 'NO']);
    expect(backend.answers.single['freeText'], '自由文だけ変更');
    expect(find.text('保存済み回答の補足'), findsNothing);
    expect(find.text('編集内容を保存'), findsNothing);
  });

  testWidgets(
    'changing to unknown requires confirmation before discarding free text',
    (tester) async {
      final backend = _IntakeBackend();
      backend.questions.add({..._question('q1', 0), 'status': 'active'});
      await _openQuestion(tester, backend);
      await tester.enterText(find.byKey(const ValueKey('回答（任意）')), '補足を保持');
      backend.reviewAfterAnswer = true;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回答を編集'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('保存済み回答の補足')), '編集した補足');

      await tester.tap(find.text('わからない').last);
      await tester.pumpAndSettle();
      expect(find.text('補足を削除しますか？'), findsOneWidget);
      await tester.tap(find.text('戻る'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('保存済み回答の補足')), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('保存済み回答の補足')))
            .controller!
            .text,
        '編集した補足',
      );

      await tester.tap(find.text('わからない').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('補足を削除して変更'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('保存済み回答の補足')))
            .controller!
            .text,
        isEmpty,
      );
      await tester.ensureVisible(find.text('編集内容を保存'));
      await tester.tap(find.text('編集内容を保存'));
      await tester.pumpAndSettle();
      expect(backend.answerPatches.single['answerState'], 'unknown');
      expect(backend.answerPatches.single['freeText'], isNull);
    },
  );

  testWidgets(
    'unknown PATCH result and failed reconciliation keep edits and offer GET-only retry',
    (tester) async {
      final backend = _IntakeBackend()..loseAnswerPatchResponse = true;
      backend.questions.add({..._question('q1', 0), 'status': 'active'});
      await _openQuestion(tester, backend);
      backend.reviewAfterAnswer = true;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回答を編集'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('保存済み回答の補足')), '結果照合待ち');
      backend.failNextIntakeGet = true;
      await tester.ensureVisible(find.text('編集内容を保存'));
      await tester.tap(find.text('編集内容を保存'));
      await tester.pumpAndSettle();

      expect(backend.answerPatches, hasLength(1));
      expect(backend.requestPaths.last, 'GET /v1/intakes/intake-1');
      expect(find.byKey(const ValueKey('保存済み回答の補足')), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('保存済み回答の補足')))
            .controller!
            .text,
        '結果照合待ち',
      );
      expect(find.text('保存状態を再取得'), findsOneWidget);
      expect(find.text('保存済みの回答'), findsOneWidget);

      await tester.tap(find.text('保存状態を再取得'));
      await tester.pumpAndSettle();
      expect(backend.answerPatches, hasLength(1));
      expect(
        backend.requestPaths.where((path) => path.startsWith('PATCH ')),
        hasLength(1),
      );
      expect(find.text('保存状態を再取得'), findsNothing);
      expect(find.byKey(const ValueKey('保存済み回答の補足')), findsOneWidget);
      expect(find.text('結果照合待ち'), findsWidgets);
      expect(find.textContaining('現在の保存内容を確認し'), findsOneWidget);
    },
  );

  testWidgets('does not claim a saved-answer edit after a revision conflict', (
    tester,
  ) async {
    final backend = _IntakeBackend()..rejectAnswerPatch = true;
    backend.questions.add({..._question('q1', 0), 'status': 'active'});
    await _openQuestion(tester, backend);
    backend.reviewAfterAnswer = true;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('回答を編集'));
    await tester.tap(find.text('回答を編集'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('いいえ'));
    await tester.pump();
    await tester.ensureVisible(find.text('編集内容を保存'));
    await tester.tap(find.text('編集内容を保存'));
    await tester.pumpAndSettle();

    expect(backend.answerPatches, hasLength(1));
    expect(backend.revision, 4);
    expect(find.text('保存済み補足'), findsNothing);
    expect(find.byKey(const ValueKey('保存済み回答の補足')), findsOneWidget);
    expect(find.textContaining('競合により拒否'), findsOneWidget);
  });

  testWidgets(
    'shows latest question after a revision and blocks stale answer edits',
    (tester) async {
      final backend = _IntakeBackend();
      backend.questions.add({..._question('q1', 0), 'status': 'active'});
      await _openQuestion(tester, backend);
      backend.reviewAfterAnswer = true;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回答を編集'));
      await tester.pumpAndSettle();

      backend.questions.single
        ..['questionRevision'] = 2
        ..['questionText'] = '更新後の質問q1';
      backend.loseAnswerPatchResponse = true;
      await tester.ensureVisible(find.text('編集内容を保存'));
      await tester.tap(find.text('編集内容を保存'));
      await tester.pumpAndSettle();

      expect(find.text('更新後の質問q1'), findsOneWidget);
      expect(find.text('合成の質問q1'), findsNothing);
      expect(
        find.text('質問が更新されました。古い回答を送信せず、編集を取り消して最新内容を確認してください。'),
        findsOneWidget,
      );
      expect(backend.answerPatches.single['questionRevision'], 1);
      final saveButton = tester.widget<FilledButton>(
        find.ancestor(
          of: find.text('編集内容を保存'),
          matching: find.byType(FilledButton),
        ),
      );
      expect(saveButton.onPressed, isNull);
    },
  );

  for (final status in [400, 401, 403, 404, 412]) {
    testWidgets('explicit PATCH $status rejection retains editable draft', (
      tester,
    ) async {
      final backend = _IntakeBackend()..answerPatchRejectStatus = status;
      backend.questions.add({..._question('q1', 0), 'status': 'active'});
      await _openQuestion(tester, backend);
      backend.reviewAfterAnswer = true;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回答を編集'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('保存済み回答の補足')), '保持する草稿');
      await tester.ensureVisible(find.text('編集内容を保存'));
      await tester.tap(find.text('編集内容を保存'));
      await tester.pumpAndSettle();

      expect(backend.answerPatches, hasLength(1));
      expect(
        backend.requestPaths.last,
        'PATCH /v1/intakes/intake-1/answers/q1',
      );
      expect(find.text('保存状態を再取得'), findsNothing);
      expect(find.text('編集内容を保存'), findsOneWidget);
      expect(find.textContaining('保存操作の成否は確認できませんでした'), findsNothing);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('保存済み回答の補足')))
            .controller!
            .text,
        '保持する草稿',
      );
    });
  }

  testWidgets(
    '409 stays rejected even if another write created matching values',
    (tester) async {
      final backend = _IntakeBackend()
        ..rejectAnswerPatch = true
        ..concurrentIdenticalAnswerPatch = true;
      backend.questions.add({..._question('q1', 0), 'status': 'active'});
      await _openQuestion(tester, backend);
      backend.reviewAfterAnswer = true;
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回答を編集'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('いいえ'));
      await tester.pump();
      await tester.ensureVisible(find.text('編集内容を保存'));
      await tester.tap(find.text('編集内容を保存'));
      await tester.pumpAndSettle();

      expect(backend.revision, 5);
      expect(backend.answerPatches, hasLength(1));
      expect(find.byKey(const ValueKey('保存済み回答の補足')), findsOneWidget);
      expect(find.text('保存状態を再取得'), findsNothing);
      expect(find.text('編集内容を保存'), findsOneWidget);
      expect(find.text('合成の質問q1'), findsOneWidget);
      expect(
        backend.requestPaths.where((path) => path.startsWith('PATCH ')),
        hasLength(1),
      );
    },
  );

  testWidgets('session change clears saved-answer edit state', (tester) async {
    final backend = _IntakeBackend()..switchSessionOnPatch = true;
    backend.questions.add({..._question('q1', 0), 'status': 'active'});
    final changes = StreamController<void>();
    addTearDown(changes.close);
    backend.onSessionSwitch = () => changes.add(null);
    await _openQuestion(tester, backend, changes: changes.stream);
    backend.reviewAfterAnswer = true;
    await tester.tap(find.text('はい'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('回答を編集'));
    await tester.tap(find.text('回答を編集'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('いいえ'));
    await tester.pump();
    await tester.ensureVisible(find.text('編集内容を保存'));
    await tester.tap(find.text('編集内容を保存'));
    await tester.pumpAndSettle();

    expect(find.text('保存済みの回答'), findsNothing);
    expect(find.byKey(const ValueKey('保存済み回答の補足')), findsNothing);
    expect(
      find.text('発行されたアカウントでログインしてください。未完了の登録手続きはログイン後に案内します。'),
      findsOneWidget,
    );
  });

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
    'mismatched answerId in 2xx is uncertain and explicit retry reuses the same key and body',
    (tester) async {
      final backend = _IntakeBackend()
        ..answerResponseOverride = {'answerId': 'wrong', 'intakeRevision': 2};
      await _openQuestion(tester, backend);
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(find.text('同じ回答を再送して確認'), findsOneWidget);
      expect(find.text('合成の質問q1'), findsOneWidget);
      final key = backend.answerKeys.single;
      final body = Map<String, dynamic>.from(backend.answerBodies.single);
      backend.answerResponseOverride = null;
      await tester.ensureVisible(find.text('同じ回答を再送して確認'));
      await tester.tap(find.text('同じ回答を再送して確認'));
      await tester.pumpAndSettle();

      expect(backend.answerKeys, [key, key]);
      expect(backend.answerBodies, [body, body]);
      expect(find.text('合成の質問q2'), findsOneWidget);
    },
  );

  testWidgets(
    'overlarge intakeRevision in 2xx is uncertain and explicit retry reuses the same key and body',
    (tester) async {
      final backend = _IntakeBackend()
        ..answerResponseOverride = {'answerId': 'q1', 'intakeRevision': 999};
      await _openQuestion(tester, backend);
      await tester.tap(find.text('はい'));
      await tester.pumpAndSettle();

      expect(find.text('同じ回答を再送して確認'), findsOneWidget);
      expect(find.text('合成の質問q1'), findsOneWidget);
      final key = backend.answerKeys.single;
      final body = Map<String, dynamic>.from(backend.answerBodies.single);
      backend.answerResponseOverride = null;
      await tester.ensureVisible(find.text('同じ回答を再送して確認'));
      await tester.tap(find.text('同じ回答を再送して確認'));
      await tester.pumpAndSettle();

      expect(backend.answerKeys, [key, key]);
      expect(backend.answerBodies, [body, body]);
      expect(find.text('合成の質問q2'), findsOneWidget);
    },
  );

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

  for (final scenario in [
    (
      name: '合成施設は受付中',
      syntheticRecipient: true,
      receivingEnabled: true,
      sendable: true,
    ),
    (
      name: '別患者のpending施設は受付不可',
      syntheticRecipient: false,
      receivingEnabled: true,
      sendable: false,
    ),
    (
      name: '停止中の合成施設は受付不可',
      syntheticRecipient: false,
      receivingEnabled: false,
      sendable: false,
    ),
  ]) {
    testWidgets('${scenario.name} の表示と送信可否が一致する', (tester) async {
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
              'verificationStatus': 'pending',
              'syntheticRecipient': scenario.syntheticRecipient,
              'receivingEnabled': scenario.receivingEnabled,
            };
          case '/v1/public/legal-documents':
            response = {
              'documents': {
                'hospital_disclosure': {
                  'version': 'v2',
                  'documentHash': 'hash',
                },
              },
            };
          case '/v1/deliveries':
            sent = jsonDecode(request.body) as Map<String, dynamic>;
            response = {'deliveryId': 'delivery'};
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
      expect(
        find.text('合成デモ施設です。実際の医療機関ではありません。'),
        scenario.syntheticRecipient ? findsOneWidget : findsNothing,
      );
      expect(
        find.text('この施設は現在受け付けていません。送信できません。'),
        scenario.sendable ? findsNothing : findsOneWidget,
      );
      await tap('「合成データ施設」へ、この問診票と選択した情報を送信することに同意します');
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, '同意した施設へ送信'),
      );
      expect(button.onPressed != null, scenario.sendable);
      if (scenario.sendable) {
        await tap('同意した施設へ送信');
        expect(sent, isNotNull);
      } else {
        expect(sent, isNull);
      }
    });
  }
}
