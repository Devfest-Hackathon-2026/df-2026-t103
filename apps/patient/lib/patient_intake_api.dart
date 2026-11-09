import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'demo_registration_transport.dart';
import 'patient_me_snapshot.dart';
import 'patient_screen_access.dart';

class IntakeIdentity {
  const IntakeIdentity(this.uid, this.epoch, this.token);
  final String uid;
  final Object epoch;
  final String token;
}

class IntakeApiException implements Exception {
  const IntakeApiException(this.code);
  final String code;
}

/// One submission attempt. Keep it on uncertain failures; a retry uses the same
/// creation key and symptom text. Never reuse it across authentication sessions.
class IntakeSubmission {
  IntakeSubmission(String text, {List<String> bodyLocations = const []})
    : text = text.trim(),
      bodyLocations = List.unmodifiable(bodyLocations),
      key = List.generate(
        24,
        (_) => Random.secure().nextInt(256),
      ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  final String text;
  final List<String> bodyLocations;
  final String key;
  String? _intakeId;
  IntakeIdentity? _owner;
}

/// Real local API only. Production Firebase/App Check setup is a separate gate.
/// No credentials, request bodies, responses or patient text are logged/persisted.
class PatientIntakeApi {
  PatientIntakeApi({
    required this.origin,
    required this.client,
    required this.identity,
    required this.isCurrent,
  }) {
    requireDemoApiOrigin(origin);
  }
  final String origin;
  final http.Client client;
  final Future<IntakeIdentity> Function() identity;
  final bool Function(IntakeIdentity) isCurrent;

  void _check(IntakeIdentity owner) {
    if (!isCurrent(owner)) throw const IntakeApiException('SESSION_CHANGED');
  }

  Future<Map<String, dynamic>> _request(
    IntakeIdentity owner,
    String method,
    String path, {
    Map<String, Object>? body,
    String? key,
  }) async {
    _check(owner);
    final abort = Completer<void>();
    final request =
        http.AbortableRequest(
            method,
            Uri.parse('$origin/v1$path'),
            abortTrigger: abort.future,
          )
          ..followRedirects = false
          ..headers['Authorization'] = 'Bearer ${owner.token}';
    if (key != null) request.headers['Idempotency-Key'] = key;
    if (body != null) {
      request.headers['content-type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    try {
      Future<Map<String, dynamic>> send() async {
        final response = await client.send(request);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          // Do not expose server exception bodies (which may contain PHI).
          throw IntakeApiException('HTTP_${response.statusCode}');
        }
        final bytes = <int>[];
        await for (final chunk in response.stream) {
          bytes.addAll(chunk);
          if (bytes.length > 256 * 1024) {
            throw const IntakeApiException('INVALID_RESPONSE');
          }
        }
        _check(owner);
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map<String, dynamic>) {
          throw const IntakeApiException('INVALID_RESPONSE');
        }
        return decoded;
      }

      return await send().timeout(const Duration(seconds: 15));
    } on IntakeApiException {
      rethrow;
    } catch (_) {
      throw const IntakeApiException('UNAVAILABLE');
    } finally {
      abort.complete();
    }
  }

  /// GET /v1/me のデコード済み本文。UID 検証は呼び出し側（スナップショット変換時）。
  Future<Object?> meJson() async {
    final owner = await identity();
    _check(owner);
    return _meJson(owner);
  }

  Future<Map<String, dynamic>> _meJson(IntakeIdentity owner) async {
    final decoded = await _request(owner, 'GET', '/me');
    _check(owner);
    return decoded;
  }

  Future<IntakeIdentity> requireReady() async {
    final owner = await identity();
    _check(owner);
    final me = patientAccessSnapshotFromMe(
      await _meJson(owner),
      authenticatedUid: owner.uid,
    );
    if (!canAccessPatientScreen(
      screenId: 'P-010',
      auth: PatientAuthState.authenticated,
      me: me,
    )) {
      throw const IntakeApiException('ONBOARDING_REQUIRED');
    }
    return owner;
  }

  /// POST /v1/onboarding/consents（同意記録。Idempotency-Key 必須）。
  /// [consents] は consentType -> {accepted, documentVersion}。
  Future<void> recordOnboardingConsents({
    required Map<String, Map<String, Object>> consents,
    required String idempotencyKey,
  }) async {
    if (consents.isEmpty) throw const IntakeApiException('INVALID_INPUT');
    final owner = await identity();
    _check(owner);
    await _request(
      owner,
      'POST',
      '/onboarding/consents',
      body: {'consents': consents, 'locale': 'ja-JP'},
      key: idempotencyKey,
    );
    _check(owner);
  }

  /// PATCH /v1/me/profile（プロフィール更新。現行同意必須）。
  Future<void> patchProfile(Map<String, Object> patch) async {
    if (patch.isEmpty) throw const IntakeApiException('INVALID_INPUT');
    final owner = await identity();
    _check(owner);
    await _request(owner, 'PATCH', '/me/profile', body: patch);
    _check(owner);
  }

  /// Saves initial symptoms, then reads the actual saved record. This does not
  /// finalize a questionnaire or deliver information to a medical institution.
  /// Returns the intake revision once it reaches `questioning` (2), which the
  /// question loop uses as the first `expectedIntakeRevision`.
  Future<int> submit(IntakeSubmission submission) async {
    if (submission.text.isEmpty ||
        submission.text.length > 1000 ||
        !RegExp(r'[぀-ヿ一-鿿a-zA-Z0-9]').hasMatch(submission.text)) {
      throw const IntakeApiException('INVALID_INPUT');
    }
    final owner = await requireReady();
    final previous = submission._owner;
    if (previous != null &&
        (previous.uid != owner.uid ||
            !identical(previous.epoch, owner.epoch))) {
      throw const IntakeApiException('SESSION_CHANGED');
    }
    submission._owner = owner;
    if (submission._intakeId == null) {
      final created = await _request(
        owner,
        'POST',
        '/intakes',
        body: {'locale': 'ja-JP'},
        key: submission.key,
      );
      final id = created['intakeId'];
      if (id is! String ||
          !RegExp(r'^[A-Za-z0-9_-]{1,200}$').hasMatch(id) ||
          created['status'] != 'draft' ||
          created['revision'] != 1) {
        throw const IntakeApiException('INVALID_RESPONSE');
      }
      submission._intakeId = id;
    }
    final path = '/intakes/${submission._intakeId}';
    var stored = await _request(owner, 'GET', path);
    if (stored['status'] == 'draft' && stored['revision'] == 1) {
      await _request(
        owner,
        'POST',
        '$path/symptoms',
        body: {
          'initialSymptomText': submission.text,
          'bodyLocations': submission.bodyLocations,
          'expectedIntakeRevision': 1,
        },
      );
      stored = await _request(owner, 'GET', path);
    }
    _check(owner);
    final revision = stored['revision'];
    if (stored['intakeId'] != submission._intakeId ||
        stored['initialSymptomText'] != submission.text ||
        stored['status'] != 'questioning' ||
        revision != 2) {
      throw const IntakeApiException('SAVE_NOT_CONFIRMED');
    }
    return revision as int;
  }

  /// Confirms the submission still belongs to the current session and has a
  /// started intake. The question loop methods below read [IntakeSubmission]
  /// state established by [submit].
  Future<IntakeIdentity> _resume(IntakeSubmission submission) async {
    final owner = await identity();
    _check(owner);
    final previous = submission._owner;
    if (previous == null ||
        previous.uid != owner.uid ||
        !identical(previous.epoch, owner.epoch)) {
      throw const IntakeApiException('SESSION_CHANGED');
    }
    if (submission._intakeId == null) {
      throw const IntakeApiException('NOT_STARTED');
    }
    return owner;
  }

  /// API-012. Asks the backend for the next question. The server generates it
  /// with the LLM (or the deterministic fixed set as fallback) and persists a
  /// snapshot before returning. A `null` question means questioning is complete
  /// and the caller should move to the review summary.
  Future<NextQuestion> nextQuestion(
    IntakeSubmission submission,
    int expectedIntakeRevision,
  ) async {
    final owner = await _resume(submission);
    final res = await _request(
      owner,
      'POST',
      '/intakes/${submission._intakeId}/next-question',
      body: {'expectedIntakeRevision': expectedIntakeRevision},
    );
    final revision = res['intakeRevision'];
    if (revision is! int) {
      throw const IntakeApiException('INVALID_RESPONSE');
    }
    final question = res['question'];
    if (question == null) return NextQuestion(null, revision);
    if (question is! Map<String, dynamic>) {
      throw const IntakeApiException('INVALID_RESPONSE');
    }
    return NextQuestion(_parseQuestion(question), revision);
  }

  IntakeQuestion _parseQuestion(Map<String, dynamic> q) {
    final id = q['questionId'];
    final text = q['questionText'];
    final topic = q['topic'];
    final generatedBy = q['generatedBy'];
    final questionRevision = q['questionRevision'];
    final stepIndex = q['stepIndex'];
    final rawOptions = q['options'];
    if (id is! String ||
        text is! String ||
        topic is! String ||
        generatedBy is! String ||
        questionRevision is! int ||
        stepIndex is! int ||
        rawOptions is! List) {
      throw const IntakeApiException('INVALID_RESPONSE');
    }
    final options = <IntakeOption>[];
    for (final o in rawOptions) {
      if (o is! Map || o['code'] is! String || o['label'] is! String) {
        throw const IntakeApiException('INVALID_RESPONSE');
      }
      options.add(IntakeOption(o['code'] as String, o['label'] as String));
    }
    final modelVersion = q['modelVersion'];
    return IntakeQuestion(
      questionId: id,
      questionRevision: questionRevision,
      stepIndex: stepIndex,
      questionText: text,
      topic: topic,
      options: options,
      generatedBy: generatedBy,
      modelVersion: modelVersion is String ? modelVersion : null,
    );
  }

  /// API-013. Saves the patient's answer to [question]. `answerState` is one of
  /// `answered`, `unknown`, `skipped`. Returns the new intake revision, which
  /// must be threaded into the following request as `expectedIntakeRevision`.
  Future<int> saveAnswer(
    IntakeSubmission submission, {
    required IntakeQuestion question,
    required List<String> selectedCodes,
    required String answerState,
    required int expectedIntakeRevision,
    String? freeText,
  }) async {
    final owner = await _resume(submission);
    final res = await _request(
      owner,
      'POST',
      '/intakes/${submission._intakeId}/answers',
      body: {
        'questionId': question.questionId,
        'questionRevision': question.questionRevision,
        'selectedCodes': selectedCodes,
        'answerState': answerState,
        'expectedIntakeRevision': expectedIntakeRevision,
        'freeText': ?freeText,
      },
    );
    final revision = res['intakeRevision'];
    if (revision is! int) {
      throw const IntakeApiException('INVALID_RESPONSE');
    }
    return revision;
  }

  /// API-015. Moves the intake to `review` and returns the summary. Unanswered
  /// topics stay unanswered (they are not inferred as "none").
  Future<IntakeSummary> summarize(
    IntakeSubmission submission,
    int expectedIntakeRevision,
  ) async {
    final owner = await _resume(submission);
    final res = await _request(
      owner,
      'POST',
      '/intakes/${submission._intakeId}/summary',
      body: {'expectedIntakeRevision': expectedIntakeRevision},
    );
    final revision = res['intakeRevision'];
    final summary = res['summary'];
    if (revision is! int ||
        res['status'] != 'review' ||
        summary is! Map<String, dynamic>) {
      throw const IntakeApiException('INVALID_RESPONSE');
    }
    final chief = summary['chiefComplaint'];
    final chiefValue = chief is Map ? chief['value'] : null;
    final unanswered = <String>[];
    final rawUnanswered = summary['unansweredTopics'];
    if (rawUnanswered is List) {
      for (final t in rawUnanswered) {
        if (t is String) unanswered.add(t);
      }
    }
    return IntakeSummary(
      intakeRevision: revision,
      chiefComplaint: chiefValue is String ? chiefValue : null,
      unansweredTopics: unanswered,
    );
  }

  /// API-016. Finalizes the reviewed intake into an immutable questionnaire.
  /// The patient must have confirmed the review (`summaryReviewConfirmed`).
  Future<void> finalize(
    IntakeSubmission submission,
    int expectedIntakeRevision,
  ) async {
    final owner = await _resume(submission);
    final res = await _request(
      owner,
      'POST',
      '/intakes/${submission._intakeId}/finalize',
      body: {
        'expectedIntakeRevision': expectedIntakeRevision,
        'summaryReviewConfirmed': true,
      },
      key: 'finalize-${submission.key}',
    );
    if (res['status'] != 'finalized') {
      throw const IntakeApiException('SAVE_NOT_CONFIRMED');
    }
  }
}

/// One selectable choice on a question.
class IntakeOption {
  const IntakeOption(this.code, this.label);
  final String code;
  final String label;
}

/// A generated question snapshot returned by the backend (API-012).
class IntakeQuestion {
  const IntakeQuestion({
    required this.questionId,
    required this.questionRevision,
    required this.stepIndex,
    required this.questionText,
    required this.topic,
    required this.options,
    required this.generatedBy,
    this.modelVersion,
  });
  final String questionId;
  final int questionRevision;
  final int stepIndex;
  final String questionText;
  final String topic;
  final List<IntakeOption> options;

  /// `llm` when produced by the model, `fallback`/`fixed_template` otherwise.
  final String generatedBy;
  final String? modelVersion;
}

/// Result of a next-question request. A `null` [question] ends questioning.
class NextQuestion {
  const NextQuestion(this.question, this.intakeRevision);
  final IntakeQuestion? question;
  final int intakeRevision;
}

/// Minimal review summary (API-015) used to confirm before finalizing.
class IntakeSummary {
  const IntakeSummary({
    required this.intakeRevision,
    required this.chiefComplaint,
    required this.unansweredTopics,
  });
  final int intakeRevision;
  final String? chiefComplaint;
  final List<String> unansweredTopics;
}
