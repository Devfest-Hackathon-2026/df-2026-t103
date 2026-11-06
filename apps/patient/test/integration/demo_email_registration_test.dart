import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/demo_registration_transport.dart';
import 'package:patient/email_auth_client.dart';

class _NoAutomaticSignIn implements EmailSignIn {
  @override
  Future<void> signIn(String email, String password) async {
    throw StateError('Registration must not sign in automatically');
  }
}

void main() {
  const enabled = bool.fromEnvironment('RUN_DEMO_AUTH_INTEGRATION');
  test(
    'local registration, retry, emulator sign-in, and /me',
    () async {
      final client = http.Client();
      String? idToken;
      try {
        final legal = await client.get(
          Uri.parse('http://127.0.0.1:8080/v1/public/legal-documents'),
        );
        expect(legal.statusCode, 200);
        final json = jsonDecode(legal.body) as Map<String, dynamic>;
        final required = (json['requiredConsents'] as List).cast<String>();
        final documents = json['documents'] as Map<String, dynamic>;
        final consents = <String, ConsentSelection>{
          for (final type in required)
            type: ConsentSelection(
              accepted: true,
              documentVersion:
                  (documents[type] as Map<String, dynamic>)['version']
                      as String,
            ),
        };
        final suffix = DateTime.now().microsecondsSinceEpoch;
        final email = 'synthetic-$suffix@example.invalid';
        const password = 'demo-password-123';
        final auth = EmailAuthClient(
          transport: DemoRegistrationTransport(
            baseUrl: 'http://127.0.0.1:8080',
            client: client,
          ),
          signInProvider: _NoAutomaticSignIn(),
          requiredConsentTypes: required.toSet(),
        );
        Future<void> register() => auth.register(
          email: email,
          password: password,
          consents: consents,
          idempotencyKey: 'integration-$suffix',
        );
        await register();
        await register(); // Same key and payload must be safe to retry.

        final signIn = await client.post(
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
        expect(signIn.statusCode, 200);
        idToken =
            (jsonDecode(signIn.body) as Map<String, dynamic>)['idToken']
                as String;
        final me = await client.get(
          Uri.parse('http://127.0.0.1:8080/v1/me'),
          headers: {'authorization': 'Bearer $idToken'},
        );
        expect(me.statusCode, 200);
        final account = jsonDecode(me.body) as Map<String, dynamic>;
        expect(
          (account['requiredConsents'] as Map<String, dynamic>)['current'],
          true,
        );
        expect(account['profileComplete'], false);
      } finally {
        if (idToken != null) {
          await client.post(
            Uri.parse(
              'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:delete?key=demo-key',
            ),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'idToken': idToken}),
          );
        }
        client.close();
      }
    },
    skip: !enabled,
    timeout: const Timeout(Duration(seconds: 30)),
  );
}
