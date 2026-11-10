import 'package:flutter_test/flutter_test.dart';
import 'package:patient/patient_redirect.dart';
import 'package:patient/patient_screen_access.dart';

PatientAccessSnapshot _me({
  String? status = 'active',
  String onboarding = 'completed',
  bool? consents = true,
  bool? profile = true,
}) {
  return PatientAccessSnapshot(
    accountStatus: status,
    onboardingState: onboarding,
    requiredConsentsCurrent: consents,
    profileComplete: profile,
  );
}

void main() {
  group('patientLanding', () {
    test('認証状態が未確定ならローディング', () {
      expect(
        patientLanding(auth: PatientAuthState.unknown),
        PatientLanding.loading,
      );
    });

    test('未認証はウェルカム', () {
      expect(
        patientLanding(auth: PatientAuthState.unauthenticated),
        PatientLanding.welcome,
      );
    });

    test('認証済みで /me 未取得はローディング', () {
      expect(
        patientLanding(auth: PatientAuthState.authenticated, me: null),
        PatientLanding.loading,
      );
    });

    test('同意未確定は同意へ', () {
      expect(
        patientLanding(
          auth: PatientAuthState.authenticated,
          me: _me(onboarding: 'legal_pending', consents: false),
        ),
        PatientLanding.consent,
      );
    });

    test('同意済み・プロフィール未完了はプロフィール登録へ', () {
      expect(
        patientLanding(
          auth: PatientAuthState.authenticated,
          me: _me(onboarding: 'profile_pending', consents: true, profile: false),
        ),
        PatientLanding.profileRegistration,
      );
    });

    test('完了済みはホーム', () {
      expect(
        patientLanding(
          auth: PatientAuthState.authenticated,
          me: _me(),
        ),
        PatientLanding.home,
      );
    });

    test('退会申請中は deletionPending', () {
      expect(
        patientLanding(
          auth: PatientAuthState.authenticated,
          me: _me(status: 'pending_deletion'),
        ),
        PatientLanding.deletionPending,
      );
    });

    test('停止中は blocked', () {
      expect(
        patientLanding(
          auth: PatientAuthState.authenticated,
          me: _me(status: 'suspended'),
        ),
        PatientLanding.blocked,
      );
    });
  });

  group('patientRedirect', () {
    test('アクセス可能な画面はリダイレクトしない', () {
      expect(
        patientRedirect(
          screenId: 'P-001',
          auth: PatientAuthState.unauthenticated,
        ),
        isNull,
      );
      expect(
        patientRedirect(
          screenId: 'P-010',
          auth: PatientAuthState.authenticated,
          me: _me(),
        ),
        isNull,
      );
    });

    test('未認証で健康情報系へ直アクセスするとウェルカムへ弾く', () {
      expect(
        patientRedirect(
          screenId: 'P-010',
          auth: PatientAuthState.unauthenticated,
        ),
        PatientLanding.welcome,
      );
    });

    test('同意未確定で問診/プロフィールへ直アクセスすると同意へ弾く', () {
      final me = _me(onboarding: 'legal_pending', consents: false);
      expect(
        patientRedirect(
          screenId: 'P-010',
          auth: PatientAuthState.authenticated,
          me: me,
        ),
        PatientLanding.consent,
      );
      expect(
        patientRedirect(
          screenId: 'P-006',
          auth: PatientAuthState.authenticated,
          me: me,
        ),
        PatientLanding.consent,
      );
    });

    test('プロフィール未完了で問診へ直アクセスするとプロフィール登録へ弾く', () {
      final me =
          _me(onboarding: 'profile_pending', consents: true, profile: false);
      expect(
        patientRedirect(
          screenId: 'P-010',
          auth: PatientAuthState.authenticated,
          me: me,
        ),
        PatientLanding.profileRegistration,
      );
      // プロフィール登録自体には入れる
      expect(
        patientRedirect(
          screenId: 'P-006',
          auth: PatientAuthState.authenticated,
          me: me,
        ),
        isNull,
      );
    });
  });
}
