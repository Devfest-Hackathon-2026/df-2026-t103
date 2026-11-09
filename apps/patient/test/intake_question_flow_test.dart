import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:patient/intake_question_flow.dart';
import 'package:patient/patient_intake_api.dart';

Map<String, dynamic> _readyMe() => {
  'uid': 'patient-a',
  'accountStatus': 'active',
  'onboardingState': 'completed',
  'emailVerified': true,
  'requiredConsents': {'current': true, 'missing': <String>[]},
  'profileComplete': true,
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

Map<String, dynamic> _question(
  String id,
  String text,
  List<Map<String, String>> options,
) => {
  'questionId': id,
  'stepIndex': 0,
  'questionText': text,
  'topic': 'onset_timing',
  'options': options,
  'generatedBy': 'llm',
  'modelVersion': 'gemini-test',
  'questionRevision': 1,
};

/// Drives the real [PatientIntakeApi] against a scripted backend so the test
/// exercises next-question → answers → summary → finalize end to end.
class _Backend {
  int revision = 2;
  final List<String> answered = [];
  final List<String?> answerFreeTexts = [];
  bool summarized = false;
  bool finalized = false;
  int nextCalls = 0;
  int answerRequests = 0;
  bool failAnswer = false;
  bool includeSecondQuestion = false;

  // http.Response defaults to latin1 without a charset, so always declare utf-8
  // for bodies that carry Japanese text.
  http.Response _json(Map<String, dynamic> body, [int status = 200]) =>
      http.Response(
        jsonEncode(body),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  http.Client client() => MockClient((request) async {
    final path = request.url.path;
    if (path == '/v1/me') {
      return _json(_readyMe());
    }
    if (path == '/v1/intakes' && request.method == 'POST') {
      return _json({
        'intakeId': 'intake-1',
        'status': 'draft',
        'revision': 1,
      }, 201);
    }
    if (path == '/v1/intakes/intake-1' && request.method == 'GET') {
      return _json({
        'intakeId': 'intake-1',
        'status': revision >= 2 ? 'questioning' : 'draft',
        'revision': revision >= 2 ? 2 : 1,
        'initialSymptomText': revision >= 2 ? '合成の症状' : null,
      });
    }
    if (path.endsWith('/symptoms')) {
      revision = 2;
      return _json({'ok': true});
    }
    if (path.endsWith('/next-question')) {
      final body = jsonDecode(request.body) as Map;
      expect(body['expectedIntakeRevision'], revision);
      nextCalls++;
      if (nextCalls == 1) {
        return _json({
          'intakeId': 'intake-1',
          'intakeRevision': ++revision,
          'question': _question('q1', 'いつ頃からですか？', [
            {'code': 'TODAY', 'label': '今日から'},
            {'code': 'UNKNOWN', 'label': '分からない'},
          ]),
        });
      }
      if (nextCalls == 2 && includeSecondQuestion) {
        return _json({
          'intakeId': 'intake-1',
          'intakeRevision': revision,
          'question': _question('q2', '症状は悪化していますか？', [
            {'code': 'YES', 'label': 'はい'},
            {'code': 'NO', 'label': 'いいえ'},
          ]),
        });
      }
      // No more questions.
      return _json({
        'intakeId': 'intake-1',
        'intakeRevision': revision,
        'question': null,
      });
    }
    if (path.endsWith('/answers')) {
      answerRequests++;
      final body = jsonDecode(request.body) as Map;
      expect(body['expectedIntakeRevision'], revision);
      if (failAnswer) {
        failAnswer = false;
        return _json({
          'error': {'code': 'INTERNAL'},
        }, 500);
      }
      answered.add(body['answerState'] as String);
      answerFreeTexts.add(body['freeText'] as String?);
      return _json({'answerId': 'a1', 'intakeRevision': ++revision});
    }
    if (path.endsWith('/summary')) {
      summarized = true;
      return _json({
        'intakeId': 'intake-1',
        'status': 'review',
        'intakeRevision': revision,
        'summary': {
          'chiefComplaint': {'value': '合成の症状', 'source': 'patient'},
          'sections': <String, dynamic>{},
          'unansweredTopics': ['allergy'],
          'bodyLocations': <String>[],
          'medicationSnapshots': <dynamic>[],
          'medicalHistorySnapshot': <dynamic>[],
        },
      });
    }
    if (path.endsWith('/finalize')) {
      expect(request.headers['idempotency-key'], isNotNull);
      finalized = true;
      return _json({
        'intakeId': 'intake-1',
        'questionnaireId': 'qn-1',
        'questionnaireRevision': 1,
        'status': 'finalized',
      });
    }
    return _json({'ok': true});
  });
}

void main() {
  testWidgets('drives question → answer → review → finalize via the API', (
    tester,
  ) async {
    final backend = _Backend();
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: backend.client(),
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    final submission = IntakeSubmission('合成の症状');
    final startRevision = await api.submit(submission);
    expect(startRevision, 2);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: IntakeQuestionFlow(
              api: api,
              submission: submission,
              startRevision: startRevision,
            ),
          ),
        ),
      ),
    );
    // Initial next-question load.
    await tester.pumpAndSettle();
    expect(find.text('いつ頃からですか？'), findsOneWidget);
    expect(find.text('今日から'), findsOneWidget);

    // Answer the question; flow fetches the (null) next question → review.
    await tester.enterText(find.byType(TextField), '昨夜から続いています');
    await tester.tap(find.text('今日から'));
    await tester.pumpAndSettle();
    expect(backend.answered, ['answered']);
    expect(backend.answerFreeTexts, ['昨夜から続いています']);
    expect(backend.summarized, isTrue);
    expect(find.text('ここまでの回答'), findsOneWidget);
    expect(find.textContaining('昨夜から続いています'), findsOneWidget);
    expect(find.textContaining('未回答の項目: 1件'), findsOneWidget);

    // Confirm and finalize.
    await tester.tap(find.text('この内容で問診票を確定'));
    await tester.pumpAndSettle();
    expect(backend.finalized, isTrue);
    expect(find.text('問診票を確定しました'), findsOneWidget);
  });

  testWidgets('the "分からない" option is saved as unknown', (tester) async {
    final backend = _Backend();
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: backend.client(),
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    final submission = IntakeSubmission('合成の症状');
    final startRevision = await api.submit(submission);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: IntakeQuestionFlow(
              api: api,
              submission: submission,
              startRevision: startRevision,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('分からない'));
    await tester.pumpAndSettle();
    expect(backend.answered, ['unknown']);
  });

  testWidgets('skipping does not submit entered free text', (tester) async {
    final backend = _Backend();
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: backend.client(),
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    final submission = IntakeSubmission('合成の症状');
    final startRevision = await api.submit(submission);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: IntakeQuestionFlow(
              api: api,
              submission: submission,
              startRevision: startRevision,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('いつ頃からですか？'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '送信しない内容');
    await tester.tap(find.text('答えたくない'));
    await tester.pumpAndSettle();
    expect(backend.answered, ['skipped']);
    expect(backend.answerFreeTexts, [null]);
    expect(find.byType(TextField), findsNothing);
    expect(find.text('ここまでの回答'), findsOneWidget);
  });

  testWidgets('blocks text exceeding API UTF-16 length before sending', (
    tester,
  ) async {
    final backend = _Backend();
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: backend.client(),
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    final submission = IntakeSubmission('合成の症状');
    final startRevision = await api.submit(submission);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: IntakeQuestionFlow(
              api: api,
              submission: submission,
              startRevision: startRevision,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('いつ頃からですか？'), findsOneWidget);
    // 1001 emoji are 1001 grapheme clusters but 2002 UTF-16 code units.
    await tester.enterText(find.byType(TextField), '😀' * 1001);
    await tester.tap(find.text('今日から'));
    await tester.pumpAndSettle();
    expect(backend.answered, isEmpty);
    expect(find.textContaining('API上限'), findsOneWidget);
  });

  testWidgets('saves free text and clears it when the next question arrives', (
    tester,
  ) async {
    final backend = _Backend()..includeSecondQuestion = true;
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: backend.client(),
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    final submission = IntakeSubmission('合成の症状');
    final startRevision = await api.submit(submission);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: IntakeQuestionFlow(
              api: api,
              submission: submission,
              startRevision: startRevision,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final textField = find.byType(TextField);
    await tester.enterText(textField, '昨夜から続いています');
    await tester.tap(find.text('今日から'));
    await tester.pumpAndSettle();

    expect(backend.answerFreeTexts, ['昨夜から続いています']);
    expect(find.text('症状は悪化していますか？'), findsOneWidget);
    expect(tester.widget<TextField>(textField).controller!.text, isEmpty);
  });

  testWidgets('does not advance after uncertain answer save failure', (
    tester,
  ) async {
    final backend = _Backend()..failAnswer = true;
    final owner = IntakeIdentity('patient-a', Object(), 'synthetic-token');
    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: backend.client(),
      identity: () async => owner,
      isCurrent: (_) => true,
    );
    final submission = IntakeSubmission('合成の症状');
    final startRevision = await api.submit(submission);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: IntakeQuestionFlow(
              api: api,
              submission: submission,
              startRevision: startRevision,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('いつ頃からですか？'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '保存結果不明の回答');
    await tester.tap(find.text('今日から'));
    await tester.pumpAndSettle();
    expect(backend.nextCalls, 1);
    expect(backend.answerRequests, 1);
    expect(find.text('再試行'), findsNothing);
    expect(find.text('いつ頃からですか？'), findsOneWidget);
    expect(find.textContaining('安全に再開・照合する方法がない'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '保存結果不明の回答',
    );

    // Neither another option nor skip nor edits can cause a stale-revision
    // answer request after the save outcome became uncertain.
    await tester.tap(find.text('今日から'));
    await tester.tap(find.text('答えたくない'));
    await tester.pumpAndSettle();
    expect(backend.answerRequests, 1);
    expect(backend.nextCalls, 1);
    expect(find.text('再試行'), findsNothing);
  });
}
