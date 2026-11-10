import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';

import 'firebase_bootstrap.dart';

/// The caller supplies a transport configured for the API and App Check policy.
/// It must not log or persist headers or body, and must not follow redirects.
abstract interface class RegistrationTransport {
  Future<int> postRegistration({
    required Map<String, String> headers,
    required Map<String, Object> body,
  });
}

abstract interface class EmailSignIn {
  Future<void> signIn(String email, String password);
}

/// Only constructs a Firebase sign-in adapter after selecting the demo emulator.
class DemoEmailSignIn implements EmailSignIn {
  DemoEmailSignIn._(this._auth);
  final FirebaseAuth _auth;

  static Future<DemoEmailSignIn> connect(
    FirebaseApp app,
    EmulatorConfig config,
  ) async {
    // EmulatorConfig.validate is the single host guard: it rejects anything
    // but loopback (plus the Android emulator alias) before Firebase is used.
    config.validate(androidHostAliasAllowed: allowsAndroidHostAlias);
    if (app.options.projectId != config.projectId) {
      throw StateError(
        'Firebase project does not match the demo configuration.',
      );
    }
    final auth = FirebaseAuth.instanceFor(app: app);
    await auth.useAuthEmulator(config.host, 9099);
    return DemoEmailSignIn._(auth);
  }

  @override
  Future<void> signIn(String email, String password) async {
    await _auth.signInWithEmailAndPassword(email: email, password: password);
  }
}

enum EmailAuthFailure {
  invalidInput,
  registrationRejected,
  unavailable,
  signInFailed,
  // Too many attempts or a temporary lock (FR-A02). Distinct from a plain
  // failure so the UI can ask the user to wait instead of retrying at once,
  // without revealing whether the account exists.
  rateLimited,
}

class EmailAuthException implements Exception {
  const EmailAuthException(this.reason, {this.statusCode});
  final EmailAuthFailure reason;
  final int? statusCode;
}

class ConsentSelection {
  const ConsentSelection({
    required this.accepted,
    required this.documentVersion,
  });
  final bool accepted;
  final String documentVersion;
}

/// Registration and sign-in are separate: a failed sign-in must not repeat a
/// successful registration. Reuse the same key and body when retrying a request
/// whose outcome is unknown; the API retains its idempotency record for a time.
class EmailAuthClient {
  EmailAuthClient({
    required this.transport,
    required this.signInProvider,
    required Set<String> requiredConsentTypes,
  }) : requiredConsentTypes = Set.unmodifiable(requiredConsentTypes) {
    if (!requiredConsentTypes.containsAll(_baselineConsents) ||
        requiredConsentTypes.any((type) => !_allowedConsents.contains(type))) {
      throw const EmailAuthException(EmailAuthFailure.invalidInput);
    }
  }
  final RegistrationTransport transport;
  final EmailSignIn signInProvider;

  /// Required types from the current server document configuration.
  final Set<String> requiredConsentTypes;

  static const _baselineConsents = {
    'terms_of_service',
    'privacy_policy_ack',
    'health_data_collection',
  };
  static const _allowedConsents = {
    ..._baselineConsents,
    'hospital_disclosure',
    'optional_analytics',
  };

  Future<void> register({
    required String email,
    required String password,
    required Map<String, ConsentSelection> consents,
    required String idempotencyKey,
    String? appCheckToken,
    String locale = 'ja-JP',
  }) async {
    // Field limits mirror the API's registerBodySchema (email max 254,
    // password 8-128, locale 2-20 after trim) so obviously oversized input
    // fails before the network. Format rules (email shape, password
    // composition) stay server-side to avoid drifting from the schema.
    if (email.trim().isEmpty ||
        email.trim().length > 254 ||
        password.length < 8 ||
        password.length > 128 ||
        locale.trim().length < 2 ||
        locale.trim().length > 20 ||
        idempotencyKey.isEmpty ||
        idempotencyKey.length > 200 ||
        RegExp(r'\s').hasMatch(idempotencyKey) ||
        consents.keys.any((key) => !_allowedConsents.contains(key)) ||
        requiredConsentTypes.any((key) => consents[key]?.accepted != true) ||
        consents.values.any(
          (value) =>
              value.documentVersion.isEmpty ||
              value.documentVersion.length > 100,
        )) {
      throw const EmailAuthException(EmailAuthFailure.invalidInput);
    }
    final headers = <String, String>{
      'Idempotency-Key': idempotencyKey,
      if (appCheckToken != null && appCheckToken.isNotEmpty)
        'X-Firebase-AppCheck': appCheckToken,
    };
    final body = <String, Object>{
      'email': email,
      'password': password,
      'locale': locale,
      'consents': {
        for (final entry in consents.entries)
          entry.key: {
            'accepted': entry.value.accepted,
            'documentVersion': entry.value.documentVersion,
          },
      },
    };
    final int status;
    try {
      status = await transport.postRegistration(headers: headers, body: body);
    } catch (_) {
      throw const EmailAuthException(EmailAuthFailure.unavailable);
    }
    if (status == 429) {
      // The API throttled the request; the account state is unchanged (FR-A02).
      throw const EmailAuthException(EmailAuthFailure.rateLimited, statusCode: 429);
    }
    if (status != 201) {
      throw EmailAuthException(
        EmailAuthFailure.registrationRejected,
        statusCode: status,
      );
    }
  }

  Future<void> signIn({required String email, required String password}) async {
    if (email.trim().isEmpty || password.isEmpty) {
      throw const EmailAuthException(EmailAuthFailure.invalidInput);
    }
    try {
      await signInProvider.signIn(email, password);
    } on FirebaseAuthException catch (e) {
      // Firebase reports both throttling and temporary account locks as
      // too-many-requests; surface it as rate limited so the UI asks the user
      // to wait (FR-A02). The error detail is not propagated to avoid leaking
      // credentials or whether the account exists.
      if (e.code == 'too-many-requests') {
        throw const EmailAuthException(EmailAuthFailure.rateLimited);
      }
      throw const EmailAuthException(EmailAuthFailure.signInFailed);
    } catch (_) {
      throw const EmailAuthException(EmailAuthFailure.signInFailed);
    }
  }
}
