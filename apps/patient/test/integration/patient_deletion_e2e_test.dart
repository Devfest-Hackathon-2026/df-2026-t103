import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/patient_deletion_client.dart';
import 'package:patient/patient_intake_api.dart' show IntakeIdentity;

String idemKey(String prefix) {
  final suffix = List.generate(8, (_) => Random.secure().nextInt(16).toRadixString(16)).join();
  return '$prefix-$suffix';
}

void main() {
  const enabled = bool.fromEnvironment('RUN_INTAKE_UI_INTEGRATION');

  // E2E-005（docs/03 §10）: 退会申請で保留状態に入り、取消で復帰する患者側ライフサイクル。
  test('deletion request and cancel round-trips against the live API (E2E-005)', () async {
    final client = http.Client();
    addTearDown(client.close);

    final signIn = await client.post(
      Uri.parse(
        'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key',
      ),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({
        'email': 'synthetic-deletion@example.test',
        'password': 'local-only-deletion-123!',
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

    final deletion = PatientDeletionClient(
      origin: 'http://127.0.0.1:8080',
      client: client,
      identity: () async => owner,
      isCurrent: (value) => identical(value, owner),
    );

    // Starts out with no deletion request.
    final before = await deletion.status();
    expect(before.status, 'none');

    // A fresh sign-in satisfies the server's re-auth window, so the request is
    // accepted and the account enters the 30-day hold.
    final requested = await deletion.requestDeletion(idemKey('del'));
    expect(requested.status, 'pending_deletion');
    expect(requested.canCancel, isTrue);

    // Cancelling within the window restores the account; the request itself is
    // now recorded as cancelled and can no longer be cancelled again.
    final cancelled = await deletion.cancelDeletion(idemKey('cancel'));
    expect(cancelled.status, 'cancelled');
    expect(cancelled.canCancel, isFalse);

    // The cancelled state is durable on re-read.
    final after = await deletion.status();
    expect(after.status, 'cancelled');
  }, skip: !enabled);
}
