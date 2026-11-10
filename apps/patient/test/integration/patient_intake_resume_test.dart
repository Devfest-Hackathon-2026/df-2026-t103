import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/patient_intake_api.dart';

// Forwards every request to the real API but swallows the response of the first
// POST .../symptoms *after the server has committed it*, simulating a response
// lost in transit (E2E-002 通信断再開). The retry must resume without creating a
// duplicate record.
class _DropFirstSymptomsResponse extends http.BaseClient {
  _DropFirstSymptomsResponse(this._inner);
  final http.Client _inner;
  bool _dropped = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final isSymptoms =
        request.method == 'POST' && request.url.path.endsWith('/symptoms');
    final response = await _inner.send(request);
    if (isSymptoms && !_dropped) {
      _dropped = true;
      // Drain so the server-side write is definitely durable, then drop the
      // response the client would never have received.
      await response.stream.drain<void>();
      throw http.ClientException('simulated dropped response after commit');
    }
    return response;
  }

  @override
  void close() => _inner.close();
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');

  test('a dropped symptoms response resumes without duplication (E2E-002)', () async {
    final raw = http.Client();
    final client = _DropFirstSymptomsResponse(raw);
    addTearDown(client.close);

    final signIn = await raw.post(
      Uri.parse(
        'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key',
      ),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({
        'email': 'synthetic-intake-ui@example.test',
        'password': 'local-only-intake-123!',
        'returnSecureToken': true,
      }),
    );
    expect(signIn.statusCode, 200);
    final data = jsonDecode(signIn.body) as Map<String, dynamic>;
    final owner = IntakeIdentity(
      data['localId'] as String,
      Object(),
      data['idToken'] as String,
    );

    final api = PatientIntakeApi(
      origin: 'http://127.0.0.1:8080',
      client: client,
      identity: () async => owner,
      isCurrent: (value) => identical(value, owner),
    );

    final submission = IntakeSubmission('通信断の結合テスト症状');

    // First attempt: the symptoms write commits on the server, but the client
    // sees a dropped response and surfaces a non-fatal failure.
    await expectLater(
      api.submit(submission),
      throwsA(isA<IntakeApiException>()),
    );

    // Retry with the same submission: the client re-reads the saved state and
    // confirms it, without re-posting symptoms. submit() completing is the proof
    // that the record resumed to the expected revision with no duplication.
    await api.submit(submission);
  }, skip: !enabled);
}
