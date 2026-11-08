import 'package:firebase_auth/firebase_auth.dart' show FirebaseAuthException;
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/federated_auth_client.dart';

class FakeFederatedSignIn implements FederatedSignIn {
  int signInCalls = 0;
  int fetchCalls = 0;
  int linkCalls = 0;

  String uid = 'federated-uid';
  Object? signInThrows;
  List<String> methods = const ['password'];
  bool fetchThrows = false;
  String linkUid = 'existing-uid';
  Object? linkThrows;

  FederatedProvider? lastProvider;
  String? lastEmail;

  @override
  Future<String> signIn(FederatedProvider provider) async {
    signInCalls++;
    lastProvider = provider;
    if (signInThrows != null) throw signInThrows!;
    return uid;
  }

  @override
  Future<List<String>> fetchSignInMethods(String email) async {
    fetchCalls++;
    lastEmail = email;
    if (fetchThrows) throw StateError('untrusted lookup detail');
    return methods;
  }

  @override
  Future<String> linkPendingCredential() async {
    linkCalls++;
    if (linkThrows != null) throw linkThrows!;
    return linkUid;
  }
}

void main() {
  late FakeFederatedSignIn provider;
  late FederatedAuthClient client;

  setUp(() {
    provider = FakeFederatedSignIn();
    client = FederatedAuthClient(signInProvider: provider);
  });

  test('a successful federated sign-in returns the authenticated uid', () async {
    final uid = await client.signIn(FederatedProvider.google);
    expect(uid, 'federated-uid');
    expect(provider.lastProvider, FederatedProvider.google);
    // No linking is ever attempted on a clean sign-in.
    expect(provider.linkCalls, 0);
  });

  test('an empty uid is treated as a sign-in failure, never a success', () async {
    provider.uid = '';
    await expectLater(
      client.signIn(FederatedProvider.passkey),
      throwsA(
        isA<FederatedAuthException>().having(
          (e) => e.reason,
          'reason',
          FederatedAuthFailure.signInFailed,
        ),
      ),
    );
  });

  test(
    'an email collision surfaces existing methods and never auto-links (FR-A05)',
    () async {
      provider.signInThrows = FirebaseAuthException(
        code: 'account-exists-with-different-credential',
        email: 'dup@example.test',
      );
      provider.methods = const ['password', 'google.com'];
      await expectLater(
        client.signIn(FederatedProvider.google),
        throwsA(
          isA<FederatedAuthException>()
              .having((e) => e.reason, 'reason', FederatedAuthFailure.emailCollision)
              .having(
                (e) => e.existingMethods,
                'existingMethods',
                const ['password', 'google.com'],
              ),
        ),
      );
      // The existing account is looked up by its email, but the client must not
      // silently link the new credential into it.
      expect(provider.lastEmail, 'dup@example.test');
      expect(provider.linkCalls, 0);
    },
  );

  test('a collision with an unreadable method list still refuses to link', () async {
    provider.signInThrows = FirebaseAuthException(
      code: 'account-exists-with-different-credential',
      email: 'dup@example.test',
    );
    provider.fetchThrows = true;
    await expectLater(
      client.signIn(FederatedProvider.google),
      throwsA(
        isA<FederatedAuthException>()
            .having((e) => e.reason, 'reason', FederatedAuthFailure.emailCollision)
            .having((e) => e.existingMethods, 'existingMethods', isEmpty),
      ),
    );
    expect(provider.linkCalls, 0);
  });

  test('throttling is reported as rate limited so the UI asks the user to wait', () async {
    provider.signInThrows = FirebaseAuthException(code: 'too-many-requests');
    await expectLater(
      client.signIn(FederatedProvider.google),
      throwsA(
        isA<FederatedAuthException>().having(
          (e) => e.reason,
          'reason',
          FederatedAuthFailure.rateLimited,
        ),
      ),
    );
  });

  test('other provider errors map to a generic failure without leaking detail', () async {
    provider.signInThrows = FirebaseAuthException(
      code: 'invalid-credential',
      message: 'secret provider detail',
    );
    await expectLater(
      client.signIn(FederatedProvider.google),
      throwsA(
        isA<FederatedAuthException>().having(
          (e) => e.reason,
          'reason',
          FederatedAuthFailure.signInFailed,
        ),
      ),
    );
  });

  test('a non-Firebase transport error maps to unavailable', () async {
    provider.signInThrows = StateError('socket closed');
    await expectLater(
      client.signIn(FederatedProvider.google),
      throwsA(
        isA<FederatedAuthException>().having(
          (e) => e.reason,
          'reason',
          FederatedAuthFailure.unavailable,
        ),
      ),
    );
  });

  test('linking is refused without proof of control of the existing account', () async {
    await expectLater(
      client.linkAfterReauth(reauthenticated: false),
      throwsA(
        isA<FederatedAuthException>().having(
          (e) => e.reason,
          'reason',
          FederatedAuthFailure.invalidInput,
        ),
      ),
    );
    // The takeover guard must stop before touching the provider.
    expect(provider.linkCalls, 0);
  });

  test('linking proceeds only after re-authentication and returns the bound uid', () async {
    final uid = await client.linkAfterReauth(reauthenticated: true);
    expect(uid, 'existing-uid');
    expect(provider.linkCalls, 1);
  });

  test('a collision during linking is surfaced, not swallowed', () async {
    provider.linkThrows = FirebaseAuthException(code: 'too-many-requests');
    await expectLater(
      client.linkAfterReauth(reauthenticated: true),
      throwsA(
        isA<FederatedAuthException>().having(
          (e) => e.reason,
          'reason',
          FederatedAuthFailure.rateLimited,
        ),
      ),
    );
  });
}
