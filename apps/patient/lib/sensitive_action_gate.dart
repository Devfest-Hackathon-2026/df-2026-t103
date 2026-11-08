import 'package:firebase_auth/firebase_auth.dart' show FirebaseAuthException;

/// Outcome of attempting a sensitive action behind a re-authentication gate.
enum ReauthOutcome {
  authorized,
  // The user is not signed in, so no sensitive action may begin.
  notSignedIn,
  // The user cancelled the re-authentication prompt.
  cancelled,
  // The supplied credential was wrong or otherwise rejected.
  reauthFailed,
  // Firebase throttled or temporarily locked re-auth (FR-A02).
  rateLimited,
  // The session changed between re-auth and the action, so it was aborted
  // (再認証切れ). The action must not run against a different session.
  sessionChanged,
  // The action itself failed after authorization.
  actionFailed,
  // Re-auth could not be completed for a transient, non-specific reason.
  unavailable,
  // Another authorize call is already in flight for this gate.
  duplicateRequest,
}

/// Performs a fresh re-authentication of the current user and reports session
/// currency. Implementations wrap Firebase `reauthenticateWithCredential`; this
/// gate never stores or logs the credential.
abstract interface class SensitiveReauthenticator {
  /// Prompts for and verifies a fresh credential for the currently signed-in
  /// user. Returns true when re-auth completed, false when the user cancelled.
  /// Throws [FirebaseAuthException] on verification failure or throttling.
  Future<bool> reauthenticate();

  /// True while the session that started the action is still the current one.
  /// Checked before re-auth and again before the action runs.
  bool isSessionCurrent();
}

/// Requires a fresh re-authentication immediately before a high-risk operation
/// (退会・パスワード/連携変更・送信前の高リスク操作, docs/02 §セキュリティ,
/// docs/03 P-040→P-041). Shared across sensitive flows so the guard is applied
/// consistently, not re-implemented per screen.
///
/// The gate does not itself render the double-confirmation UI; it guarantees the
/// security invariant that the action runs only after a successful, current
/// re-auth, and never when the session changed underneath it.
class SensitiveActionGate {
  SensitiveActionGate({required this.reauthenticator});
  final SensitiveReauthenticator reauthenticator;
  bool _busy = false;

  Future<ReauthOutcome> authorize(Future<void> Function() action) async {
    if (_busy) return ReauthOutcome.duplicateRequest;
    _busy = true;
    try {
      if (!reauthenticator.isSessionCurrent()) {
        return ReauthOutcome.notSignedIn;
      }
      final bool reauthed;
      try {
        reauthed = await reauthenticator.reauthenticate();
      } on FirebaseAuthException catch (e) {
        // Detail may reveal whether an account exists; never propagate it.
        if (e.code == 'too-many-requests') return ReauthOutcome.rateLimited;
        return ReauthOutcome.reauthFailed;
      } catch (_) {
        return ReauthOutcome.unavailable;
      }
      if (!reauthed) return ReauthOutcome.cancelled;
      // Re-auth may have taken time (e.g. a confirmation step). Re-check that the
      // same session is still current before touching the sensitive operation.
      if (!reauthenticator.isSessionCurrent()) {
        return ReauthOutcome.sessionChanged;
      }
      try {
        await action();
      } catch (_) {
        return ReauthOutcome.actionFailed;
      }
      return ReauthOutcome.authorized;
    } finally {
      _busy = false;
    }
  }
}
