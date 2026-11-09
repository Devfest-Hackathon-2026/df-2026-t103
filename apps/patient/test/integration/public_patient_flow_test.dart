import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/patient_theme.dart';
import 'package:patient/public_patient_api.dart';
import 'package:patient/public_patient_screen.dart';

// ignore: avoid_print -- consumed only by the fail-closed CI partial parser.
void _flowMarker(String marker) => print(marker);

class _LiveBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

class _CaptureIntakeIdClient extends http.BaseClient {
  _CaptureIntakeIdClient(this.inner);

  final http.Client inner;
  String? intakeId;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (request.method == 'POST') {
      final match = RegExp(r'^/v1/intakes/([^/]+)/symptoms$')
          .firstMatch(request.url.path);
      if (match != null) intakeId = match.group(1);
    }
    return inner.send(request);
  }

  @override
  void close() => inner.close();
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');
  if (enabled) _LiveBinding();

  testWidgets('public UI → real API → hospital receipt → logout', (
    tester,
  ) async {
    final client = _CaptureIntakeIdClient(http.Client());
    final changes = StreamController<void>.broadcast(sync: true);
    var epoch = Object();
    String? patientToken;
    final symptom =
        '合成問診-${DateTime.now().toUtc().microsecondsSinceEpoch}-${Random.secure().nextInt(1 << 32)}';
    final answerFreeText =
        '合成自由回答-${DateTime.now().toUtc().microsecondsSinceEpoch}-${Random.secure().nextInt(1 << 32)}';
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
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('お腹').last);
      await tester.pumpAndSettle();
      await tap('保存して質問へ進む');
      var submittedFreeText = false;
      String? selectedOptionLabel;
      for (var step = 0; step < 20; step++) {
        await waitFor(
          find.byWidgetPredicate(
            (w) => w is Text && (w.data == 'わからない' || w.data == '問診の内容を確認しました'),
          ),
        );
        if (find.text('問診の内容を確認しました').evaluate().isNotEmpty) break;
        if (!submittedFreeText) {
          final answerField = find.byKey(const ValueKey('回答（任意）'));
          await tester.enterText(answerField, answerFreeText);
          final optionButton = find.byType(FilledButton).first;
          final optionText =
              tester.widget<FilledButton>(optionButton).child! as Text;
          selectedOptionLabel = optionText.data!;
          await tap(selectedOptionLabel);
          submittedFreeText = true;
        } else {
          await tap('わからない');
        }
      }
      expect(submittedFreeText, isTrue);
      await waitFor(find.text('問診の内容を確認しました'));
      expect(find.text(symptom), findsOneWidget);
      await tap('問診の内容を確認しました');
      final intakeId = client.intakeId;
      expect(intakeId, isNotNull);
      Future<Map<String, dynamic>> getIntake() async {
        final response = await tester.runAsync(
          () => client.get(
            Uri.parse('http://127.0.0.1:8080/v1/intakes/$intakeId'),
            headers: {'Authorization': 'Bearer $patientToken'},
          ),
        );
        expect(response, isNotNull);
        expect(response!.statusCode, 200);
        return jsonDecode(response.body) as Map<String, dynamic>;
      }

      final beforeEdit = await getIntake();
      final previousRevision = beforeEdit['revision'] as int;
      final questionCount = beforeEdit['questionCount'] as int;
      final savedAnswers = beforeEdit['answers'] as List;
      final savedQuestions = beforeEdit['questions'] as List;
      expect(questionCount, greaterThan(0));
      expect(savedQuestions, hasLength(questionCount));
      for (final answer in savedAnswers.whereType<Map<String, dynamic>>()) {
        final question = savedQuestions
            .whereType<Map<String, dynamic>>()
            .singleWhere((item) => item['questionId'] == answer['questionId']);
        expect(answer['questionRevision'], question['questionRevision']);
      }
      final savedAnswer = savedAnswers
          .whereType<Map<String, dynamic>>()
          .singleWhere((answer) => answer['freeText'] == answerFreeText);
      final answerId = savedAnswer['answerId'] as String;
      final editedQuestion = savedQuestions
          .whereType<Map<String, dynamic>>()
          .singleWhere((question) => question['questionId'] == answerId);
      final editedStepIndex = editedQuestion['stepIndex'] as int;
      final downstreamQuestions = savedQuestions
          .whereType<Map<String, dynamic>>()
          .where(
            (question) =>
                (question['stepIndex'] as int) > editedStepIndex &&
                (question['status'] == 'active' ||
                    question['status'] == 'answered'),
          )
          .toList();
      expect(
        downstreamQuestions,
        isNotEmpty,
        reason: 'The free-text answer should exercise an early-question edit.',
      );
      final selectedCodes = List<String>.from(
        savedAnswer['selectedCodes'] as List,
      );
      final editedFreeText = '$answerFreeText（編集済み）';
      final answerCard = find.ancestor(
        of: find.text(answerFreeText),
        matching: find.byType(Card),
      );
      final editButton = find.descendant(
        of: answerCard,
        matching: find.text('回答を編集'),
      );
      await tester.ensureVisible(editButton);
      _flowMarker('edit-open-start');
      await tap('回答を編集');
      _flowMarker('edit-open-tap-returned');
      await tester.pump();
      final editField = find.byKey(const ValueKey('保存済み回答の補足'));
      if (editField.evaluate().isNotEmpty) {
        _flowMarker('edit-field-found');
      }
      await tester.enterText(editField, editedFreeText);
      _flowMarker('edit-input-returned');
      _flowMarker('edit-save-start');
      await tap('編集内容を保存');
      _flowMarker('edit-save-tap-returned');
      final afterEdit = await getIntake();
      expect(afterEdit['revision'], previousRevision + 1);
      expect(afterEdit['status'], 'questioning');
      final editedQuestions = afterEdit['questions'] as List;
      final retainedQuestion = editedQuestions
          .whereType<Map<String, dynamic>>()
          .singleWhere((question) => question['questionId'] == answerId);
      expect(
        retainedQuestion['questionRevision'],
        editedQuestion['questionRevision'],
      );
      final editedAnswers = afterEdit['answers'] as List;
      final updatedAnswer = editedAnswers
          .whereType<Map<String, dynamic>>()
          .singleWhere((answer) => answer['answerId'] == answerId);
      expect(updatedAnswer['freeText'], editedFreeText);
      expect(updatedAnswer['selectedCodes'], selectedCodes);
      expect(updatedAnswer['answerState'], savedAnswer['answerState']);
      expect(
        updatedAnswer['questionRevision'],
        savedAnswer['questionRevision'],
      );
      for (final question in downstreamQuestions) {
        final invalidatedQuestion = editedQuestions
            .whereType<Map<String, dynamic>>()
            .singleWhere(
              (item) => item['questionId'] == question['questionId'],
            );
        expect(
          invalidatedQuestion['questionRevision'],
          question['questionRevision'],
        );
        expect(invalidatedQuestion['status'], 'invalidated');
        expect(
          editedAnswers.whereType<Map<String, dynamic>>().any(
            (answer) => answer['answerId'] == question['questionId'],
          ),
          isFalse,
          reason: 'Invalidated branch answers must not remain in the intake.',
        );
      }
      // Editing an early answer invalidates the old downstream branch. Follow
      // the real patient UI/API path through replacement questions and back to
      // review rather than assuming PATCH leaves the intake in review.
      var returnedToReview = false;
      for (var step = 0; step < 20; step++) {
        if (find.text('問診の内容を確認しました').evaluate().isNotEmpty) {
          returnedToReview = true;
          break;
        }
        await waitFor(
          find.byWidgetPredicate(
            (w) => w is Text && (w.data == 'わからない' || w.data == '問診の内容を確認しました'),
          ),
        );
        if (find.text('問診の内容を確認しました').evaluate().isNotEmpty) {
          returnedToReview = true;
          break;
        }
        await tap('わからない');
      }
      expect(returnedToReview, isTrue);
      _flowMarker('requestion');
      final restoredReview = await getIntake();
      expect(restoredReview['status'], 'review');
      expect(
        restoredReview['revision'],
        greaterThan(afterEdit['revision'] as int),
      );
      final restoredAnswer = (restoredReview['answers'] as List)
          .whereType<Map<String, dynamic>>()
          .singleWhere((answer) => answer['answerId'] == answerId);
      expect(
        restoredAnswer['questionRevision'],
        savedAnswer['questionRevision'],
      );
      expect(restoredAnswer['freeText'], editedFreeText);
      _flowMarker('review');
      await waitFor(find.text('問診の内容を確認しました'));
      await tap('この内容で問診票を確定');
      await waitFor(find.text('合成データ受入施設'));
      await tap('「合成データ受入施設」へ、この問診票と選択した情報を送信することに同意します');
      await tap('同意した施設へ送信');
      await waitFor(find.text('施設の受信箱へ届きました'));
      _flowMarker('hospital');
      final staffToken = await tester.runAsync(
        () => login(
          'synthetic-public-staff@example.test',
          'local-only-public-staff-123!',
        ),
      );
      const facility = 'synthetic-public-facility';
      final headers = {'Authorization': 'Bearer $staffToken'};
      String? cursor;
      final seenCursors = <String>{};
      final matchingDetails = <Map<String, dynamic>>[];
      var exhaustedPages = false;
      for (var page = 0; page < 5; page++) {
        final uri = Uri.parse(
          'http://127.0.0.1:8080/v1/hospitals/$facility/deliveries',
        ).replace(queryParameters: {'limit': '10', 'cursor': ?cursor});
        final inbox = await tester.runAsync(
          () => client.get(uri, headers: headers),
        );
        expect(inbox!.statusCode, 200);
        final payload = jsonDecode(inbox.body) as Map<String, dynamic>;
        final rows = payload['deliveries'] as List;
        for (final row in rows.whereType<Map>()) {
          final deliveryId = row['deliveryId'];
          if (deliveryId is! String) continue;
          final received = await tester.runAsync(
            () => client.get(
              Uri.parse(
                'http://127.0.0.1:8080/v1/hospitals/$facility/deliveries/$deliveryId',
              ),
              headers: headers,
            ),
          );
          expect(received!.statusCode, 200);
          final body = jsonDecode(received.body) as Map<String, dynamic>;
          final snapshot = body['questionnaireSnapshot'] as Map;
          if ((snapshot['chiefComplaint'] as Map)['value'] == symptom) {
            matchingDetails.add(body);
          }
        }
        final nextCursor = payload['nextCursor'];
        expect(nextCursor, anyOf(isNull, isA<String>()));
        if (nextCursor == null) {
          exhaustedPages = true;
          break;
        }
        expect(
          seenCursors.add(nextCursor as String),
          isTrue,
          reason: 'Delivery cursor repeated; pagination may be looping.',
        );
        cursor = nextCursor;
      }
      expect(
        exhaustedPages,
        isTrue,
        reason: 'Delivery pagination exceeded safety cap (50 details).',
      );
      expect(
        matchingDetails,
        hasLength(1),
        reason: 'Exactly this run\'s delivery must exist.',
      );
      final matchedBody = matchingDetails.single;
      expect(matchedBody['questionnaireSnapshot'], isA<Map>());
      final snapshot = matchedBody['questionnaireSnapshot'] as Map;
      expect((snapshot['chiefComplaint'] as Map)['value'], symptom);
      expect(snapshot['bodyLocations'], contains('abdomen'));
      final sections = snapshot['sections'] as Map;
      final freeTextSections = sections.entries.where((entry) {
        final section = entry.value;
        return section is Map &&
            section['answerState'] == 'answered' &&
            section['value'] is String &&
            (section['value'] as String).contains(editedFreeText);
      }).toList();
      expect(
        freeTextSections,
        hasLength(1),
        reason: 'The selected answer and free text must be in one answered topic section.',
      );
      final answerSection = freeTextSections.single.value as Map;
      expect(answerSection['value'], '$selectedOptionLabel　$editedFreeText');
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
