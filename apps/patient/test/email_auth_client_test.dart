import 'package:firebase_auth/firebase_auth.dart' show FirebaseAuthException;
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/email_auth_client.dart';

class FakeTransport implements RegistrationTransport {
  int calls = 0;
  int status = 201;
  bool fail = false;
  Map<String, String>? headers;
  Map<String, Object>? body;

  @override
  Future<int> postRegistration({
    required Map<String, String> headers,
    required Map<String, Object> body,
  }) async {
    calls++;
    this.headers = headers;
    this.body = body;
    if (fail) throw StateError('untrusted transport detail');
    return status;
  }
}

class FakeSignIn implements EmailSignIn {
  int calls = 0;
  bool fail = false;
  // When set, signIn throws this instead of the generic StateError.
  Object? throwThis;
  @override
  Future<void> signIn(String email, String password) async {
    calls++;
    if (throwThis != null) throw throwThis!;
    if (fail) throw StateError('untrusted provider detail');
  }
}

void main() {
  late FakeTransport transport;
  late FakeSignIn signIn;
  late EmailAuthClient client;
  const accepted = ConsentSelection(accepted: true, documentVersion: 'v1');
  const consents = {
    'terms_of_service': accepted,
    'privacy_policy_ack': accepted,
    'health_data_collection': accepted,
  };

  setUp(() {
    transport = FakeTransport();
    signIn = FakeSignIn();
    client = EmailAuthClient(
      transport: transport,
      signInProvider: signIn,
      requiredConsentTypes: consents.keys.toSet(),
    );
  });

  Future<void> register({
    Map<String, ConsentSelection> selections = consents,
    String key = 'test-key',
    String email = 'person@example.invalid',
    String password = 'example123',
    String locale = 'ja-JP',
  }) => client.register(
    email: email,
    password: password,
    consents: selections,
    idempotencyKey: key,
    appCheckToken: 'test-token',
    locale: locale,
  );

  Future<void> expectInvalidInput(Future<void> future) async {
    await expectLater(
      future,
      throwsA(
        isA<EmailAuthException>().having(
          (e) => e.reason,
          'reason',
          EmailAuthFailure.invalidInput,
        ),
      ),
    );
  }

  test('sends API contract without automatically signing in', () async {
    await register();
    expect(transport.headers, {
      'Idempotency-Key': 'test-key',
      'X-Firebase-AppCheck': 'test-token',
    });
    expect(transport.body!['locale'], 'ja-JP');
    expect((transport.body!['consents'] as Map)['terms_of_service'], {
      'accepted': true,
      'documentVersion': 'v1',
    });
    expect(signIn.calls, 0);
    await client.signIn(
      email: 'person@example.invalid',
      password: 'example123',
    );
    expect(signIn.calls, 1);
  });

  test(
    'rejects missing or denied consent and invalid key without sending',
    () async {
      for (final selection in [
        <String, ConsentSelection>{},
        {
          ...consents,
          'health_data_collection': const ConsentSelection(
            accepted: false,
            documentVersion: 'v1',
          ),
        },
      ]) {
        await expectLater(
          register(selections: selection),
          throwsA(
            isA<EmailAuthException>().having(
              (e) => e.reason,
              'reason',
              EmailAuthFailure.invalidInput,
            ),
          ),
        );
      }
      await expectLater(
        register(key: 'bad key'),
        throwsA(isA<EmailAuthException>()),
      );
      expect(transport.calls, 0);
    },
  );

  test('rejects incomplete or unknown server consent configurations', () {
    for (final required in [
      <String>{},
      {...consents.keys, 'unknown_type'},
    ]) {
      expect(
        () => EmailAuthClient(
          transport: transport,
          signInProvider: signIn,
          requiredConsentTypes: required,
        ),
        throwsA(isA<EmailAuthException>()),
      );
    }
  });

  test('requires newly required known consent without sending', () async {
    client = EmailAuthClient(
      transport: transport,
      signInProvider: signIn,
      requiredConsentTypes: {...consents.keys, 'optional_analytics'},
    );
    await expectLater(register(), throwsA(isA<EmailAuthException>()));
    expect(transport.calls, 0);
  });

  test('does not sign in after a rejected or failed registration', () async {
    transport.status = 412;
    await expectLater(
      register(),
      throwsA(
        isA<EmailAuthException>().having((e) => e.statusCode, 'status', 412),
      ),
    );
    transport.fail = true;
    await expectLater(
      register(),
      throwsA(
        isA<EmailAuthException>().having(
          (e) => e.reason,
          'reason',
          EmailAuthFailure.unavailable,
        ),
      ),
    );
    expect(signIn.calls, 0);
  });

  test('sanitizes provider failures', () async {
    signIn.fail = true;
    await expectLater(
      client.signIn(email: 'person@example.invalid', password: 'example123'),
      throwsA(
        isA<EmailAuthException>().having(
          (e) => e.reason,
          'reason',
          EmailAuthFailure.signInFailed,
        ),
      ),
    );
  });

  test('surfaces too-many-requests sign-in as rate limited (FR-A02)', () async {
    signIn.throwThis = FirebaseAuthException(code: 'too-many-requests');
    await expectLater(
      client.signIn(email: 'person@example.invalid', password: 'example123'),
      throwsA(
        isA<EmailAuthException>().having(
          (e) => e.reason,
          'reason',
          EmailAuthFailure.rateLimited,
        ),
      ),
    );
  });

  test('other FirebaseAuth errors stay a generic sign-in failure', () async {
    signIn.throwThis = FirebaseAuthException(code: 'wrong-password');
    await expectLater(
      client.signIn(email: 'person@example.invalid', password: 'example123'),
      throwsA(
        isA<EmailAuthException>().having(
          (e) => e.reason,
          'reason',
          EmailAuthFailure.signInFailed,
        ),
      ),
    );
  });

  test('registration throttling (429) is rate limited, not rejected (FR-A02)',
      () async {
    transport.status = 429;
    await expectLater(
      register(),
      throwsA(
        isA<EmailAuthException>()
            .having((e) => e.reason, 'reason', EmailAuthFailure.rateLimited)
            .having((e) => e.statusCode, 'status', 429),
      ),
    );
    expect(signIn.calls, 0);
  });

  group('registration input limits mirror the API schema', () {
    test('rejects oversized or truncated fields without sending', () async {
      final tooLongEmail = '${'a' * 249}@example.invalid'; // 265 > 254
      await expectInvalidInput(register(email: tooLongEmail));
      await expectInvalidInput(register(email: '   '));
      await expectInvalidInput(register(password: 'abc1234')); // 7 < 8
      await expectInvalidInput(
        register(password: 'a1${'b' * 128}'), // 130 > 128
      );
      await expectInvalidInput(register(locale: 'a')); // 1 < 2
      await expectInvalidInput(register(locale: 'a' * 21)); // 21 > 20
      await expectInvalidInput(
        register(
          selections: {
            ...consents,
            'terms_of_service': ConsentSelection(
              accepted: true,
              documentVersion: 'v' * 101,
            ),
          },
        ),
      );
      await expectInvalidInput(
        register(
          selections: {
            ...consents,
            'terms_of_service': const ConsentSelection(
              accepted: true,
              documentVersion: '',
            ),
          },
        ),
      );
      await expectInvalidInput(
        register(
          selections: {...consents, 'unknown_type': accepted},
        ),
      );
      expect(transport.calls, 0);
    });

    test('accepts values at the API schema boundaries', () async {
      await register(
        email: '${'a' * (254 - '@example.invalid'.length)}@example.invalid',
      );
      await register(password: 'a1${'b' * 6}'); // exactly 8
      await register(password: 'a1${'b' * 126}'); // exactly 128
      await register(locale: 'ab'); // exactly 2
      await register(locale: 'a' * 20); // exactly 20
      expect(transport.calls, 5);
    });
  });
}
