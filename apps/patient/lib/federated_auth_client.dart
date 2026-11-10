import 'package:firebase_auth/firebase_auth.dart' show FirebaseAuthException;

/// Federated identity providers offered to patients (FR-A03/FR-A05).
enum FederatedProvider { google, passkey }

enum FederatedAuthFailure {
  invalidInput,
  // The email already belongs to a different sign-in method. Per FR-A05 the
  // client never links automatically; the user must first authenticate with an
  // existing method so a federated credential cannot take over the account.
  emailCollision,
  // Firebase throttles or temporarily locks the attempt (FR-A02). Distinct so
  // the UI asks the user to wait, without revealing whether the account exists.
  rateLimited,
  signInFailed,
  unavailable,
}

class FederatedAuthException implements Exception {
  const FederatedAuthException(
    this.reason, {
    this.existingMethods = const <String>[],
  });
  final FederatedAuthFailure reason;

  /// Populated only for [FederatedAuthFailure.emailCollision]: the sign-in
  /// methods already bound to the email, so the UI can direct the user to the
  /// original method. May be empty if the lookup is unavailable.
  final List<String> existingMethods;
}

/// Low-level federated sign-in, wrapping the platform provider SDK. The adapter
/// must not log or persist credentials. It reports provider-level problems as
/// [FirebaseAuthException]; this client maps those to [FederatedAuthException].
abstract interface class FederatedSignIn {
  /// Completes a provider sign-in and returns the authenticated UID. Throws
  /// [FirebaseAuthException] 'account-exists-with-different-credential' when the
  /// email already belongs to a different method, 'too-many-requests' when
  /// throttled.
  Future<String> signIn(FederatedProvider provider);

  /// Sign-in methods already bound to [email]; used only to guide collision
  /// recovery, never to grant access.
  Future<List<String>> fetchSignInMethods(String email);

  /// Links the pending federated credential to the already-authenticated
  /// existing account. The adapter must only expose a pending credential after
  /// the user re-authenticated with an existing method; [FederatedAuthClient]
  /// also refuses to call this without that proof.
  Future<String> linkPendingCredential();
}

/// Client-side policy for federated (Google/Passkey) authentication.
///
/// This layer owns one security invariant from FR-A05: a federated sign-in
/// whose email collides with an existing account must never be linked
/// automatically, and the federated credential must not inherit the existing
/// account's consents or permissions. Consent and access are always re-derived
/// from a trusted /me after sign-in, never assumed from the provider.
class FederatedAuthClient {
  FederatedAuthClient({required this.signInProvider});
  final FederatedSignIn signInProvider;

  Future<String> signIn(FederatedProvider provider) async {
    final String uid;
    try {
      uid = await signInProvider.signIn(provider);
    } on FirebaseAuthException catch (e) {
      throw await _mapFirebase(e);
    } catch (_) {
      // Provider/transport detail may contain private data; never propagate it.
      throw const FederatedAuthException(FederatedAuthFailure.unavailable);
    }
    if (uid.isEmpty) {
      throw const FederatedAuthException(FederatedAuthFailure.signInFailed);
    }
    return uid;
  }

  /// Completes account linking after the user proved control of the existing
  /// account by re-authenticating with an existing method. A caller that has
  /// not done so is refused before the provider is touched (takeover guard).
  Future<String> linkAfterReauth({required bool reauthenticated}) async {
    if (!reauthenticated) {
      throw const FederatedAuthException(FederatedAuthFailure.invalidInput);
    }
    final String uid;
    try {
      uid = await signInProvider.linkPendingCredential();
    } on FirebaseAuthException catch (e) {
      throw await _mapFirebase(e);
    } catch (_) {
      throw const FederatedAuthException(FederatedAuthFailure.unavailable);
    }
    if (uid.isEmpty) {
      throw const FederatedAuthException(FederatedAuthFailure.signInFailed);
    }
    return uid;
  }

  Future<FederatedAuthException> _mapFirebase(FirebaseAuthException e) async {
    switch (e.code) {
      case 'account-exists-with-different-credential':
        // Discover the existing methods so the UI can guide the user to the
        // original one. A lookup failure must not downgrade the collision into
        // a retriable error, and must never result in an automatic link.
        var methods = const <String>[];
        final email = e.email;
        if (email != null && email.isNotEmpty) {
          try {
            methods = List.unmodifiable(
              await signInProvider.fetchSignInMethods(email),
            );
          } catch (_) {
            methods = const <String>[];
          }
        }
        return FederatedAuthException(
          FederatedAuthFailure.emailCollision,
          existingMethods: methods,
        );
      case 'too-many-requests':
        return const FederatedAuthException(FederatedAuthFailure.rateLimited);
      default:
        return const FederatedAuthException(FederatedAuthFailure.signInFailed);
    }
  }
}
