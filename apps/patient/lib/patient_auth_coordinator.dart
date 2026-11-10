import 'patient_me_snapshot.dart';
import 'patient_screen_access.dart';

/// A definitive rejection must only be reported when the registration service
/// guarantees no account was created. All ambiguous failures are unknown.
enum RegistrationOutcome { created, rejected, unknown }

enum PatientAuthOutcome {
  ready,
  consentRequired,
  accessBlocked,
  registrationRejected,
  registrationUnknown,
  signInFailed,
  meUnavailable,
  uidMismatch,
  sessionChanged,
  duplicateRequest,
}

/// The generation must change on every auth event, including a refresh or a
/// sign-out followed by sign-in with the same UID.
class AuthSessionIdentity {
  const AuthSessionIdentity(this.uid, this.generation);
  final String uid;
  final Object generation;
}

/// Thrown by a sign-in adapter when the completed sign-in operation does not
/// match the current auth session, so no identity can be safely bound.
class AuthSessionChangedException implements Exception {
  const AuthSessionChangedException();
}

/// In-memory orchestration only; it configures neither Firebase nor an API.
///
/// Supply callbacks wrapping EmailAuthClient.register/signIn and a trusted /me
/// loader. The sign-in callback returns the authenticated session identity and
/// must bind it to the UID reported by the completed sign-in operation, not
/// merely read currentSession, so another user's session cannot be substituted.
/// currentSession must reflect auth changes immediately. Credentials remain the
/// caller's responsibility and are not retained here. Do not use this as an
/// authorization boundary or as evidence of approved legal consent. A new
/// instance must not be used to blindly repeat an unresolved registration.
class PatientAuthCoordinator {
  PatientAuthCoordinator({
    required Future<RegistrationOutcome> Function() register,
    required Future<AuthSessionIdentity> Function() signIn,
    required AuthSessionIdentity? Function() currentSession,
    required Future<Object?> Function(String uid) loadMe,
    // Named callbacks are public while the stored fields remain private.
    // ignore: prefer_initializing_formals
  }) : _register = register,
       // ignore: prefer_initializing_formals
       _signIn = signIn,
       // ignore: prefer_initializing_formals
       _currentSession = currentSession,
       // ignore: prefer_initializing_formals
       _loadMe = loadMe;

  final Future<RegistrationOutcome> Function() _register;
  final Future<AuthSessionIdentity> Function() _signIn;
  final AuthSessionIdentity? Function() _currentSession;
  final Future<Object?> Function(String uid) _loadMe;
  bool _busy = false;
  RegistrationOutcome? _registration;
  String? _signedInUid;

  /// Only the latest successful /me snapshot is exposed; clear it on every
  /// attempt and on every external auth event via [invalidateSession].
  PatientAccessSnapshot? get snapshot => _snapshot;
  PatientAccessSnapshot? _snapshot;
  int _generation = 0;

  void invalidateSession() {
    _generation++;
    _snapshot = null;
  }

  Future<PatientAuthOutcome> run() async {
    if (_busy) return PatientAuthOutcome.duplicateRequest;
    _busy = true;
    _snapshot = null;
    final generation = _generation;
    try {
      if (_registration == null) {
        try {
          _registration = await _register();
        } catch (_) {
          _registration = RegistrationOutcome.unknown;
        }
      }
      if (_registration == RegistrationOutcome.unknown) {
        return PatientAuthOutcome.registrationUnknown;
      }
      if (_registration == RegistrationOutcome.rejected) {
        return PatientAuthOutcome.registrationRejected;
      }
      if (generation != _generation) return PatientAuthOutcome.sessionChanged;

      final AuthSessionIdentity identity;
      try {
        identity = await _signIn();
      } on AuthSessionChangedException {
        return PatientAuthOutcome.sessionChanged;
      } catch (_) {
        return PatientAuthOutcome.signInFailed;
      }
      if (identity.uid.isEmpty) return PatientAuthOutcome.signInFailed;
      if (!_isCurrent(identity, generation)) {
        return PatientAuthOutcome.sessionChanged;
      }
      if (_signedInUid != null && _signedInUid != identity.uid) {
        return PatientAuthOutcome.uidMismatch;
      }
      _signedInUid = identity.uid;

      final Object? response;
      try {
        response = await _loadMe(identity.uid);
      } catch (_) {
        return PatientAuthOutcome.meUnavailable;
      }
      if (!_isCurrent(identity, generation)) {
        return PatientAuthOutcome.sessionChanged;
      }
      if (response is Map<String, dynamic> &&
          response['uid'] is String &&
          response['uid'] != identity.uid) {
        return PatientAuthOutcome.uidMismatch;
      }
      final PatientAccessSnapshot parsed;
      try {
        parsed = patientAccessSnapshotFromMe(
          response,
          authenticatedUid: identity.uid,
        );
      } catch (_) {
        return PatientAuthOutcome.meUnavailable;
      }
      _snapshot = parsed;
      if (parsed.requiredConsentsCurrent != true ||
          parsed.onboardingState == 'legal_pending' ||
          parsed.onboardingState == 'not_started') {
        return PatientAuthOutcome.consentRequired;
      }
      if (!canAccessPatientScreen(
        screenId: 'P-006',
        auth: PatientAuthState.authenticated,
        me: parsed,
      )) {
        return PatientAuthOutcome.accessBlocked;
      }
      return PatientAuthOutcome.ready;
    } catch (_) {
      // Callback exceptions may contain credentials or other private data.
      return PatientAuthOutcome.sessionChanged;
    } finally {
      _busy = false;
    }
  }

  bool _isCurrent(AuthSessionIdentity identity, int generation) {
    final current = _currentSession();
    return generation == _generation &&
        current != null &&
        current.uid == identity.uid &&
        current.generation == identity.generation;
  }
}
