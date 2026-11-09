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

class _BoundedClient extends http.BaseClient {
  _BoundedClient(this.inner);

  final http.Client inner;
  static const _responseIdleTimeout = Duration(seconds: 15);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await inner.send(request).timeout(_responseIdleTimeout);
    return http.StreamedResponse(
      response.stream.timeout(_responseIdleTimeout),
      response.statusCode,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      reasonPhrase: response.reasonPhrase,
      persistentConnection: response.persistentConnection,
    );
  }

  @override
  void close() => inner.close();
}

class _LoseFirstAnswerResponse extends http.BaseClient {
  _LoseFirstAnswerResponse(this.inner);

  final http.Client inner;
  final answerRequests = <({String? key, String body})>[];
  String? intakeId;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final symptomMatch = RegExp(r'^/v1/intakes/([^/]+)/symptoms$')
        .firstMatch(request.url.path);
    if (symptomMatch != null) intakeId = symptomMatch.group(1);
    final isAnswer = request.method == 'POST' &&
        RegExp(r'^/v1/intakes/([^/]+)/answers$')
            .hasMatch(request.url.path);
    if (isAnswer) {
      final bytes = await request.finalize().toBytes();
      final body = utf8.decode(bytes);
      final match = RegExp(r'^/v1/intakes/([^/]+)/answers$')
          .firstMatch(request.url.path)!;
      intakeId = match.group(1);
      answerRequests.add((
        key: request.headers['Idempotency-Key'],
        body: body,
      ));
      final forwarded = http.AbortableRequest(
        request.method,
        request.url,
        abortTrigger: (request as http.AbortableRequest).abortTrigger,
      )
        ..followRedirects = request.followRedirects
        ..maxRedirects = request.maxRedirects
        ..persistentConnection = request.persistentConnection
        ..headers.addAll(request.headers)
        ..bodyBytes = bytes;
      final response = await inner.send(forwarded);
      if (answerRequests.length == 1 &&
          response.statusCode >= 200 &&
          response.statusCode < 300) {
        await response.stream.drain<void>();
        throw http.ClientException('synthetic response loss', request.url);
      }
      return response;
    }
    return inner.send(request);
  }

  @override
  void close() => inner.close();
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');
  if (enabled) _LiveBinding();

  testWidgets(
    'patient retries a committed answer with the same key and body',
    (tester) async {
      final transport = _LoseFirstAnswerResponse(_BoundedClient(http.Client()));
      final changes = StreamController<void>.broadcast(sync: true);
      var epoch = Object();
      String? patientToken;

      Future<String> login(String email, String password) async {
        final response = await transport.post(
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
        client: transport,
        session: () => epoch,
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
        fail('Real public workflow did not reach the expected state');
      }

      Future<void> tap(String text) async {
        await tester.ensureVisible(find.text(text));
        await tester.runAsync(() async => tester.tap(find.text(text)));
        await tester.pump();
        for (var i = 0; i < 250; i++) {
          if (find.byType(LinearProgressIndicator).evaluate().isEmpty) return;
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump();
        }
        fail('Public workflow operation did not finish');
      }

      Future<Map<String, dynamic>> intakeState() async {
        final id = transport.intakeId;
        expect(id, isNotNull);
        final response = await tester.runAsync(
          () => transport.get(
            Uri.parse('http://127.0.0.1:8080/v1/intakes/$id'),
            headers: {'Authorization': 'Bearer $patientToken'},
          ),
        );
        expect(response, isNotNull);
        expect(response!.statusCode, 200);
        return jsonDecode(response.body) as Map<String, dynamic>;
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
        await tester.enterText(find.byType(TextField).first, '合成データ');
        await tap('保存して質問へ進む');
        await waitFor(find.text('わからない'));

        final before = await intakeState();
        final beforeRevision = before['revision'] as int;
        await tap('わからない');
        await waitFor(find.text('同じ回答を再送して確認'));

        final committed = await intakeState();
        final answers = committed['answers'] as List;
        expect(answers.length == 1, isTrue);
        expect(committed['revision'] == beforeRevision + 1, isTrue);
        expect(transport.answerRequests.length == 1, isTrue);

        await tap('同じ回答を再送して確認');
        await waitFor(
          find.byWidgetPredicate(
            (w) => w is Text &&
                (w.data == 'わからない' || w.data == '問診の内容を確認しました'),
          ),
        );
        expect(transport.answerRequests.length == 2, isTrue);
        expect(
          transport.answerRequests[0].key == transport.answerRequests[1].key &&
              transport.answerRequests[0].body ==
                  transport.answerRequests[1].body,
          isTrue,
        );
        final afterRetry = await intakeState();
        expect((afterRetry['answers'] as List).length == 1, isTrue);
        final currentQuestionId = afterRetry['currentQuestionId'];
        expect(
          currentQuestionId == null || currentQuestionId is String,
          isTrue,
          reason: 'Retry must return a valid current question state',
        );
        if (currentQuestionId == null) {
          expect(afterRetry['status'], 'review');
          await waitFor(find.text('問診の内容を確認しました'));
        } else {
          final questions = afterRetry['questions'];
          expect(questions is List, isTrue);
          final currentQuestions = (questions as List)
              .whereType<Map<String, dynamic>>()
              .where((question) => question['questionId'] == currentQuestionId)
              .toList();
          expect(currentQuestions.length, 1);
          final questionText = currentQuestions.single['questionText'];
          expect(questionText is String && questionText.isNotEmpty, isTrue);
          await waitFor(find.text(questionText as String));
        }
        expect(find.text('同じ回答を再送して確認'), findsNothing);
        await tester.pumpWidget(const SizedBox());
      } finally {
        transport.close();
        await changes.close();
      }
    },
    skip: !enabled,
  );
}
