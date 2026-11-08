import 'patient_screen_access.dart';

/// 現在の認証・同意・プロフィール状態から決まる「本来いるべき場所」。
///
/// ルーティング層（go_router 等）はこれを遷移先にマッピングする。画面の可視判定は
/// [canAccessPatientScreen] が担い、ここは「入れないときどこへ送るか」を決める。
/// サーバ側認可の代替ではない UI ガードである点は [canAccessPatientScreen] と同じ。
enum PatientLanding {
  /// /me 取得前・判定不能。スプラッシュ/ローディングを出す。
  loading,

  /// 未認証。認証入口（P-001）へ。
  welcome,

  /// 必須同意が未確定（P-002）。
  consent,

  /// 同意済みだがプロフィール未完了（P-006）。
  profileRegistration,

  /// 通常利用可能（P-007 ホーム）。
  home,

  /// 退会申請中（P-041 のみ）。
  deletionPending,

  /// 停止/削除済み。通常機能は使えない。
  blocked,
}

/// いまの状態で着地すべき場所を返す。[canAccessPatientScreen] の分岐に整合させる。
PatientLanding patientLanding({
  required PatientAuthState auth,
  PatientAccessSnapshot? me,
}) {
  if (auth == PatientAuthState.unknown) return PatientLanding.loading;
  if (auth == PatientAuthState.unauthenticated) return PatientLanding.welcome;
  if (me == null) return PatientLanding.loading;

  final status = me.accountStatus;
  if (status == 'pending_deletion') return PatientLanding.deletionPending;
  if (status == 'suspended' || status == 'deleted') {
    return PatientLanding.blocked;
  }

  // 不完全/未知のスナップショットは「判定不能」として扱い PHI に進めない。
  const onboardingStates = {
    'not_started',
    'legal_pending',
    'profile_pending',
    'completed',
  };
  if (!onboardingStates.contains(me.onboardingState) ||
      me.requiredConsentsCurrent == null ||
      me.profileComplete == null) {
    return PatientLanding.loading;
  }

  // アカウント未作成は初回同意（P-002）に限り有効。
  if (status == null) return PatientLanding.consent;
  if (status != 'active' && status != 'onboarding_pending') {
    return PatientLanding.blocked;
  }
  if (me.requiredConsentsCurrent == false ||
      me.onboardingState == 'legal_pending' ||
      me.onboardingState == 'not_started') {
    return PatientLanding.consent;
  }
  final ready = status == 'active' &&
      me.onboardingState == 'completed' &&
      me.profileComplete == true;
  return ready ? PatientLanding.home : PatientLanding.profileRegistration;
}

/// go_router の redirect に使う判定。[screenId] に入れるなら null、入れないなら
/// 送るべき着地点を返す。未同意で問診/プロフィール系へ直アクセスしても弾かれる
/// （#51 受入）。
PatientLanding? patientRedirect({
  required String screenId,
  required PatientAuthState auth,
  PatientAccessSnapshot? me,
}) {
  if (canAccessPatientScreen(screenId: screenId, auth: auth, me: me)) {
    return null;
  }
  return patientLanding(auth: auth, me: me);
}
