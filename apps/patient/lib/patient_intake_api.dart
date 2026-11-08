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
  IntakeSubmission(String text)
    : text = text.trim(),
      key = List.generate(
        24,
        (_) => Random.secure().nextInt(256),
      ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  final String text;
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

  Future<IntakeIdentity> requireReady() async {
    final owner = await identity();
    _check(owner);
    final me = patientAccessSnapshotFromMe(
      await _request(owner, 'GET', '/me'),
      authenticatedUid: owner.uid,
    );
    _check(owner);
    if (!canAccessPatientScreen(
      screenId: 'P-010',
      auth: PatientAuthState.authenticated,
      me: me,
    )) {
      throw const IntakeApiException('ONBOARDING_REQUIRED');
    }
    return owner;
  }

  /// Saves initial symptoms, then reads the actual saved record. This does not
  /// finalize a questionnaire or deliver information to a medical institution.
  Future<void> submit(IntakeSubmission submission) async {
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
          'bodyLocations': <String>[],
          'expectedIntakeRevision': 1,
        },
      );
      stored = await _request(owner, 'GET', path);
    }
    _check(owner);
    if (stored['intakeId'] != submission._intakeId ||
        stored['initialSymptomText'] != submission.text ||
        stored['status'] != 'questioning' ||
        stored['revision'] != 2) {
      throw const IntakeApiException('SAVE_NOT_CONFIRMED');
    }
  }
}
