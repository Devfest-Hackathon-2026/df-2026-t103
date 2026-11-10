import 'package:flutter/foundation.dart';

import 'patient_me_snapshot.dart';
import 'patient_screen_access.dart';

/// Implementations must use the currently authenticated session and trusted API.
/// Never persist or log the ID token, response, or patient data.
typedef PatientMeLoader = Future<Object?> Function(String authenticatedUid);

enum PatientSessionPhase { unresolved, signedOut, ready, unavailable }

/// In-memory state only. The caller must invoke [updateUser] for every auth
/// session change, including refreshes and sign-out, and dispose when finished.
class PatientSessionState extends ChangeNotifier {
  PatientSessionState(this._loadMe);

  final PatientMeLoader _loadMe;
  PatientSessionPhase _phase = PatientSessionPhase.unresolved;
  PatientAccessSnapshot? _snapshot;
  int _generation = 0;
  bool _disposed = false;

  PatientSessionPhase get phase => _phase;
  PatientAccessSnapshot? get snapshot => _snapshot;

  Future<void> updateUser(String? authenticatedUid) async {
    if (_disposed) return;
    final generation = ++_generation;
    _snapshot = null;
    if (authenticatedUid == null) {
      _phase = PatientSessionPhase.signedOut;
      notifyListeners();
      return;
    }
    if (authenticatedUid.isEmpty) {
      _phase = PatientSessionPhase.unavailable;
      notifyListeners();
      return;
    }
    _phase = PatientSessionPhase.unresolved;
    notifyListeners();
    if (_disposed || generation != _generation) return;
    try {
      final response = await _loadMe(authenticatedUid);
      final parsed = patientAccessSnapshotFromMe(
        response,
        authenticatedUid: authenticatedUid,
      );
      if (_disposed || generation != _generation) return;
      _snapshot = parsed;
      _phase = PatientSessionPhase.ready;
    } catch (_) {
      if (_disposed || generation != _generation) return;
      // Error details may contain sensitive information; do not expose them.
      _phase = PatientSessionPhase.unavailable;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _snapshot = null;
    super.dispose();
  }
}
