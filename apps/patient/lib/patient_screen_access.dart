/// Screen IDs are deliberately allowlisted; an unknown ID is never accessible.
/// This is a UI gate, not a substitute for server-side authorization.
enum PatientAuthState { unknown, unauthenticated, authenticated }

/// A successful, current /v1/me response. Null or unrecognized values do not
/// grant access. Do not reuse a response after sign-out or a change of user.
class PatientAccessSnapshot {
  const PatientAccessSnapshot({
    required this.accountStatus,
    required this.onboardingState,
    required this.requiredConsentsCurrent,
    required this.profileComplete,
  });

  final String? accountStatus;
  final String? onboardingState;
  final bool? requiredConsentsCurrent;
  final bool? profileComplete;
}

/// Returns whether a screen may be shown, not where to redirect. Pass null for
/// [me] while loading, on fetch failure, or when its response is invalid.
bool canAccessPatientScreen({
  required String screenId,
  required PatientAuthState auth,
  PatientAccessSnapshot? me,
}) {
  // Passkey remains unavailable until the authentication and approval flow is implemented.
  const publicScreens = {'P-001', 'P-003', 'P-004'};
  const regularScreens = {
    'P-007',
    'P-008',
    'P-010',
    'P-011',
    'P-012',
    'P-013',
    'P-014',
    'P-015',
    'P-020',
    'P-021',
    'P-022',
    'P-023',
    'P-030',
    'P-031',
    'P-032',
    'P-033',
  };

  // Reauthentication for deletion is not represented in this snapshot yet.
  // Keep P-040 unavailable until the flow can verify it explicitly.

  if (auth == PatientAuthState.unknown) return false;
  if (auth == PatientAuthState.unauthenticated) {
    return publicScreens.contains(screenId);
  }
  if (me == null) return false;

  final status = me.accountStatus;
  if (status == 'pending_deletion') return screenId == 'P-041';
  if (status == 'suspended' || status == 'deleted') return false;

  const onboardingStates = {
    'not_started',
    'legal_pending',
    'profile_pending',
    'completed',
  };
  if (!onboardingStates.contains(me.onboardingState) ||
      me.requiredConsentsCurrent == null ||
      me.profileComplete == null) {
    return false;
  }
  // A missing account is valid only for initial consent, never for PHI.
  if (status == null) {
    return me.onboardingState == 'legal_pending' &&
        me.requiredConsentsCurrent == false &&
        screenId == 'P-002';
  }
  if (status != 'active' && status != 'onboarding_pending') return false;
  if (me.requiredConsentsCurrent == false ||
      me.onboardingState == 'legal_pending' ||
      me.onboardingState == 'not_started') {
    return screenId == 'P-002';
  }
  if (screenId == 'P-006') return true;
  return status == 'active' &&
      me.onboardingState == 'completed' &&
      me.profileComplete == true &&
      regularScreens.contains(screenId);
}
