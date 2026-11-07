import 'dart:async';

import 'patient_auth_coordinator.dart';
import 'patient_session_state.dart';

/// Forwards auth events to the in-memory session consumers without configuring
/// an auth provider. Every event invalidates existing /me work, even when the
/// UID is unchanged. Event identity and ordering remain the stream owner's
/// responsibility.
class PatientAuthEventBridge {
  PatientAuthEventBridge({
    required Stream<AuthSessionIdentity?> events,
    required PatientSessionState sessionState,
    required PatientAuthCoordinator coordinator,
  }) {
    _sessionState = sessionState;
    _coordinator = coordinator;
    _subscription = events.listen(
      _onEvent,
      onError: _onError,
    );
  }

  late final PatientSessionState _sessionState;
  late final PatientAuthCoordinator _coordinator;
  late final StreamSubscription<AuthSessionIdentity?> _subscription;
  AuthSessionIdentity? _currentIdentity;
  bool _closed = false;

  /// The most recently observed identity, or null after an error/close.
  AuthSessionIdentity? get currentIdentity => _currentIdentity;

  void _onEvent(AuthSessionIdentity? identity) {
    if (_closed) return;
    _currentIdentity = identity;
    _coordinator.invalidateSession();
    // updateUser advances its own generation synchronously before awaiting /me.
    unawaited(_sessionState.updateUser(identity?.uid));
  }

  void _onError(Object _) {
    if (_closed) return;
    _currentIdentity = null;
    _coordinator.invalidateSession();
    // Empty UID intentionally maps to unavailable, not signed-in or signed-out.
    unawaited(_sessionState.updateUser(''));
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _currentIdentity = null;
    _coordinator.invalidateSession();
    unawaited(_sessionState.updateUser(null));
    await _subscription.cancel();
  }
}
