import 'package:flutter_test/flutter_test.dart';
import 'package:patient/patient_screen_access.dart';

void main() {
  test(
    'deletion request remains unavailable without reauthentication state',
    () {
      expect(
        canAccessPatientScreen(
          screenId: 'P-040',
          auth: PatientAuthState.authenticated,
          me: const PatientAccessSnapshot(
            accountStatus: 'active',
            onboardingState: 'completed',
            requiredConsentsCurrent: true,
            profileComplete: true,
          ),
        ),
        isFalse,
      );
    },
  );
  const active = PatientAccessSnapshot(
    accountStatus: 'active',
    onboardingState: 'completed',
    requiredConsentsCurrent: true,
    profileComplete: true,
  );

  bool allows(
    String screen,
    PatientAuthState auth, [
    PatientAccessSnapshot? me,
  ]) => canAccessPatientScreen(screenId: screen, auth: auth, me: me);

  test('only public authentication screens are available before sign-in', () {
    for (final screen in ['P-001', 'P-003', 'P-004']) {
      expect(allows(screen, PatientAuthState.unauthenticated), isTrue);
    }
    for (final screen in [
      'P-002',
      'P-005',
      'P-006',
      'P-010',
      'P-041',
      'P-999',
    ]) {
      expect(allows(screen, PatientAuthState.unauthenticated, active), isFalse);
    }
  });

  test('unresolved authentication or failed /me never opens screens', () {
    for (final screen in ['P-001', 'P-002', 'P-006', 'P-010', 'P-041']) {
      expect(allows(screen, PatientAuthState.unknown, active), isFalse);
      expect(allows(screen, PatientAuthState.authenticated), isFalse);
    }
  });

  test('missing or outdated consent permits only consent screen', () {
    for (final snapshot in [
      const PatientAccessSnapshot(
        accountStatus: null,
        onboardingState: 'legal_pending',
        requiredConsentsCurrent: false,
        profileComplete: false,
      ),
      const PatientAccessSnapshot(
        accountStatus: 'onboarding_pending',
        onboardingState: 'legal_pending',
        requiredConsentsCurrent: false,
        profileComplete: false,
      ),
      const PatientAccessSnapshot(
        accountStatus: 'active',
        onboardingState: 'completed',
        requiredConsentsCurrent: false,
        profileComplete: true,
      ),
    ]) {
      expect(allows('P-002', PatientAuthState.authenticated, snapshot), isTrue);
      for (final screen in ['P-006', 'P-007', 'P-010', 'P-041']) {
        expect(
          allows(screen, PatientAuthState.authenticated, snapshot),
          isFalse,
        );
      }
    }
  });

  test('profile setup requires current consent; normal screens require active completion', () {
    const pending = PatientAccessSnapshot(
      accountStatus: 'onboarding_pending',
      onboardingState: 'profile_pending',
      requiredConsentsCurrent: true,
      profileComplete: false,
    );
    expect(allows('P-006', PatientAuthState.authenticated, pending), isTrue);
    expect(allows('P-010', PatientAuthState.authenticated, pending), isFalse);
    expect(allows('P-006', PatientAuthState.authenticated, active), isTrue);
    expect(allows('P-010', PatientAuthState.authenticated, active), isTrue);
    expect(allows('P-999', PatientAuthState.authenticated, active), isFalse);
  });

  test('suspended and deleted accounts are blocked; pending deletion only sees P-041', () {
    for (final status in ['suspended', 'deleted', 'pending_deletion']) {
      final snapshot = PatientAccessSnapshot(
        accountStatus: status,
        onboardingState: 'completed',
        requiredConsentsCurrent: true,
        profileComplete: true,
      );
      for (final screen in ['P-001', 'P-002', 'P-006', 'P-010']) {
        expect(
          allows(screen, PatientAuthState.authenticated, snapshot),
          isFalse,
        );
      }
      expect(
        allows('P-041', PatientAuthState.authenticated, snapshot),
        status == 'pending_deletion',
      );
    }
  });

  test('unknown and inconsistent state never grants PHI access', () {
    for (final snapshot in [
      const PatientAccessSnapshot(
        accountStatus: 'future_status',
        onboardingState: 'completed',
        requiredConsentsCurrent: true,
        profileComplete: true,
      ),
      const PatientAccessSnapshot(
        accountStatus: 'active',
        onboardingState: 'future_state',
        requiredConsentsCurrent: true,
        profileComplete: true,
      ),
      const PatientAccessSnapshot(
        accountStatus: 'active',
        onboardingState: 'completed',
        requiredConsentsCurrent: null,
        profileComplete: true,
      ),
      const PatientAccessSnapshot(
        accountStatus: null,
        onboardingState: 'completed',
        requiredConsentsCurrent: true,
        profileComplete: true,
      ),
      const PatientAccessSnapshot(
        accountStatus: 'active',
        onboardingState: 'completed',
        requiredConsentsCurrent: true,
        profileComplete: null,
      ),
    ]) {
      for (final screen in ['P-002', 'P-006', 'P-010', 'P-041']) {
        expect(
          allows(screen, PatientAuthState.authenticated, snapshot),
          isFalse,
        );
      }
    }
  });

  test(
    'incomplete profile cannot open normal screens even if status is active',
    () {
      const snapshot = PatientAccessSnapshot(
        accountStatus: 'active',
        onboardingState: 'completed',
        requiredConsentsCurrent: true,
        profileComplete: false,
      );
      expect(allows('P-006', PatientAuthState.authenticated, snapshot), isTrue);
      expect(
        allows('P-010', PatientAuthState.authenticated, snapshot),
        isFalse,
      );
    },
  );
}
