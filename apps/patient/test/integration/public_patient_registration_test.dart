import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/public_patient_api.dart';

void main() {
  const enabled = bool.fromEnvironment('RUN_PUBLIC_REGISTRATION_INTEGRATION');

  test(
    'real API registration → Auth sign-in → emulator email verification',
    () async {
      const apiOrigin = String.fromEnvironment(
        'PUBLIC_REGISTRATION_API_ORIGIN',
        defaultValue: 'http://127.0.0.1:8080',
      );
      const authOrigin = String.fromEnvironment(
        'PUBLIC_REGISTRATION_AUTH_ORIGIN',
        defaultValue: 'http://127.0.0.1:9099',
      );
      const projectId = 'demo-mmr-dev';
      _requireLoopback(apiOrigin);
      _requireLoopback(authOrigin);

      final client = http.Client();
      final suffix = DateTime.now().microsecondsSinceEpoch;
      final email = 'synthetic-registration-$suffix@example.test';
      const password = 'Synthetic-registration-123';
      String? idToken;

      Future<http.Response> authPost(
        String method,
        Map<String, Object?> body,
      ) => client.post(
        Uri.parse(
          '$authOrigin/identitytoolkit.googleapis.com/v1/$method?key=demo-key',
        ),
        headers: {'content-type': 'application/json'},
        body: jsonEncode(body),
      );

      try {
        final registration = await client.post(
          Uri.parse('$apiOrigin/v1/auth/register'),
          headers: {
            'content-type': 'application/json',
            'x-firebase-appcheck': 'local-emulator-app-check',
            'idempotency-key': patientOperationKey(),
          },
          body: jsonEncode({
            'email': email,
            'password': password,
            'locale': 'ja-JP',
            'consents': {
              for (final type in [
                'terms_of_service',
                'privacy_policy_ack',
                'health_data_collection',
              ])
                type: {'accepted': true, 'documentVersion': 'synthetic-e2e-v1'},
            },
          }),
        );
        expect(registration.statusCode, 201, reason: registration.body);

        final signedIn = await authPost('accounts:signInWithPassword', {
          'email': email,
          'password': password,
          'returnSecureToken': true,
        });
        expect(signedIn.statusCode, 200, reason: signedIn.body);
        idToken = (jsonDecode(signedIn.body) as Map)['idToken'] as String;

        final sent = await authPost('accounts:sendOobCode', {
          'requestType': 'VERIFY_EMAIL',
          'idToken': idToken,
        });
        expect(sent.statusCode, 200, reason: sent.body);
        final codes = await client.get(
          Uri.parse('$authOrigin/emulator/v1/projects/$projectId/oobCodes'),
        );
        expect(codes.statusCode, 200, reason: codes.body);
        final entries = (jsonDecode(codes.body) as Map)['oobCodes'] as List;
        final matchingCodes = entries
            .cast<Map>()
            .where(
              (entry) =>
                  entry['email'] == email &&
                  entry['requestType'] == 'VERIFY_EMAIL',
            )
            .toList();
        expect(matchingCodes, hasLength(1));

        final verified = await authPost('accounts:update', {
          'oobCode': matchingCodes.single['oobCode'],
          'returnSecureToken': true,
        });
        expect(verified.statusCode, 200, reason: verified.body);
        final verifiedBody = jsonDecode(verified.body) as Map;
        expect(verifiedBody['emailVerified'], isTrue);
        final refreshed = await authPost('accounts:signInWithPassword', {
          'email': email,
          'password': password,
          'returnSecureToken': true,
        });
        expect(refreshed.statusCode, 200, reason: refreshed.body);
        idToken = (jsonDecode(refreshed.body) as Map)['idToken'] as String;

        final me = await client.get(
          Uri.parse('$apiOrigin/v1/me'),
          headers: {
            'authorization': 'Bearer $idToken',
            'x-firebase-appcheck': 'local-emulator-app-check',
          },
        );
        expect(me.statusCode, 200, reason: me.body);
        expect((jsonDecode(me.body) as Map)['emailVerified'], isTrue);
      } finally {
        final token = idToken;
        if (token != null) {
          await authPost('accounts:delete', {'idToken': token});
        }
        client.close();
      }
    },
    skip: !enabled,
    timeout: const Timeout(Duration(seconds: 45)),
  );
}

void _requireLoopback(String origin) {
  final uri = Uri.tryParse(origin);
  if (uri == null ||
      uri.scheme != 'http' ||
      !{'127.0.0.1', 'localhost', '[::1]'}.contains(uri.host) ||
      uri.userInfo.isNotEmpty ||
      uri.path.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw StateError('Registration integration permits loopback HTTP only');
  }
}
