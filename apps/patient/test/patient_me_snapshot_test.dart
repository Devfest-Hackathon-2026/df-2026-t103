import 'package:flutter_test/flutter_test.dart';
import 'package:patient/patient_me_snapshot.dart';
import 'package:patient/patient_screen_access.dart';

Map<String, dynamic> response() => {
  'uid': 'patient-a',
  'accountStatus': 'active',
  'onboardingState': 'completed',
  'emailVerified': true,
  'requiredConsents': {'current': true, 'missing': <String>[]},
  'profileComplete': true,
  'deletionRequest': {'status': 'none', 'canCancel': false},
};

PatientAccessSnapshot parse(Object? json, {String uid = 'patient-a'}) =>
    patientAccessSnapshotFromMe(json, authenticatedUid: uid);

bool allows(String screen, PatientAccessSnapshot snapshot) =>
    canAccessPatientScreen(
      screenId: screen,
      auth: PatientAuthState.authenticated,
      me: snapshot,
    );

void main() {
  test('a completed deletion job on a deleted account never grants access', () {
    final payload = response()
      ..['accountStatus'] = 'deleted'
      ..['deletionRequest'] = {'status': 'completed', 'canCancel': false};
    expect(allows('P-010', parse(payload)), isFalse);
  });

  test('converts the actual response shape for an authenticated user', () {
    final snapshot = parse(response());
    expect(allows('P-010', snapshot), isTrue);
    expect(snapshot.requiredConsentsCurrent, isTrue);
  });

  test('rejects fake, incomplete and incorrectly typed responses', () {
    final cases = <Object?>[
      null,
      'not JSON',
      <Object>[],
      <String, dynamic>{},
      response()..remove('uid'),
      response()..remove('accountStatus'),
      response()..remove('emailVerified'),
      response()..remove('deletionRequest'),
      response()..['uid'] = 42,
      response()..['accountStatus'] = 'future_status',
      response()..['onboardingState'] = 'future_state',
      response()..['profileComplete'] = 'true',
      response()..['requiredConsents'] = true,
      response()..['requiredConsents'] = {'current': true},
      response()..['requiredConsents'] = {'current': 'true', 'missing': []},
      response()
        ..['requiredConsents'] = {
          'current': true,
          'missing': [1],
        },
      response()
        ..['requiredConsents'] = {
          'current': true,
          'missing': ['terms'],
        },
      response()..['deletionRequest'] = {'status': 'none'},
      response()
        ..['deletionRequest'] = {'status': 'unknown', 'canCancel': false},
      response()
        ..['deletionRequest'] = {'status': 'processing', 'canCancel': false},
      response()
        ..['deletionRequest'] = {
          'status': 'none',
          'canCancel': false,
          'requestedAt': null,
        },
    ];
    for (final json in cases) {
      expect(() => parse(json), throwsFormatException, reason: '$json');
    }
  });

  test('rejects a different or empty authenticated identity', () {
    expect(() => parse(response(), uid: 'patient-b'), throwsFormatException);
    expect(() => parse(response(), uid: ''), throwsFormatException);
    expect(() => parse(response()..['uid'] = ''), throwsFormatException);
  });

  test('account and consent restrictions survive conversion', () {
    for (final status in ['suspended', 'deleted', 'pending_deletion']) {
      final payload = response()..['accountStatus'] = status;
      if (status == 'pending_deletion') {
        payload['deletionRequest'] = {
          'status': 'pending_deletion',
          'canCancel': true,
        };
      }
      final snapshot = parse(payload);
      expect(allows('P-010', snapshot), isFalse);
      expect(allows('P-041', snapshot), status == 'pending_deletion');
    }
    final noConsent = response()
      ..['requiredConsents'] = {
        'current': false,
        'missing': ['terms'],
      };
    expect(allows('P-010', parse(noConsent)), isFalse);
    expect(allows('P-002', parse(noConsent)), isTrue);
    final newAccount = response()
      ..['accountStatus'] = null
      ..['onboardingState'] = 'legal_pending'
      ..['requiredConsents'] = {
        'current': false,
        'missing': ['terms'],
      }
      ..['profileComplete'] = false;
    expect(allows('P-002', parse(newAccount)), isTrue);
    expect(allows('P-010', parse(newAccount)), isFalse);
  });

  test('a signed-in /me response without an account fails closed', () {
    // The API can report a live session before the accounts document exists:
    // accountStatus null, consents already current, onboarding profile_pending.
    // PATCH profile then fails with 403, so until the server resolves the
    // account no screen may open. This is still valid /v1/me JSON and must
    // not throw during conversion.
    final payload = response()
      ..['accountStatus'] = null
      ..['onboardingState'] = 'profile_pending'
      ..['profileComplete'] = false;
    final snapshot = parse(payload);
    expect(snapshot.accountStatus, isNull);
    expect(snapshot.onboardingState, 'profile_pending');
    expect(snapshot.requiredConsentsCurrent, isTrue);
    expect(snapshot.profileComplete, isFalse);
    for (final screen in ['P-002', 'P-006', 'P-007', 'P-010', 'P-041']) {
      expect(allows(screen, snapshot), isFalse, reason: screen);
    }
  });
}
