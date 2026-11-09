import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:patient/auth_method_screen.dart';
import 'package:patient/home_screen.dart';
import 'package:patient/patient_flow.dart';
import 'package:patient/patient_intake_api.dart';
import 'package:patient/patient_session_state.dart';
import 'package:patient/patient_theme.dart';
import 'package:patient/profile_form_screen.dart';
import 'package:patient/reconsent_contract.dart';
import 'package:patient/welcome_screen.dart';

Map<String, dynamic> me(String uid, {String onboarding = 'completed'}) => {
      'uid': uid,
      'accountStatus': 'active',
      'onboardingState': onboarding,
      'emailVerified': true,
      'requiredConsents': {
        'current': onboarding != 'legal_pending',
        'missing': <String>[],
      },
      'profileComplete': onboarding == 'completed',
      'deletionRequest': {'status': 'none', 'canCancel': false},
    };

class _FakeHost implements PatientFlowHost {
  _FakeHost({this.uid});
  final _changes = StreamController<void>.broadcast(sync: true);
  final _http = http.Client();
  String? uid;
  String? signedInEmail;

  @override
  late final PatientIntakeApi api = PatientIntakeApi(
    origin: 'http://localhost:8080',
    client: _http,
    identity: () async => throw const IntakeApiException('SIGNED_OUT'),
    isCurrent: (_) => false,
  );

  @override
  String get origin => 'http://localhost:8080';
  @override
  http.Client get client => _http;
  @override
  String? get currentUid => uid;
  @override
  Stream<void> get changes => _changes.stream;
  @override
  Future<void> signIn(String email, String password) async {
    signedInEmail = email;
    uid = 'uid-1';
    _changes.add(null);
  }

  @override
  Future<void> signOut() async {
    uid = null;
    _changes.add(null);
  }
}

Widget _app(Widget home) =>
    MaterialApp(theme: buildPatientTheme(), home: home);

void main() {
  testWidgets('未認証: 利用開始→方式選択(メールのみ有効)→メールログインで signIn',
      (tester) async {
    final host = _FakeHost();
    final session = PatientSessionState((uid) async => me(uid));
    await tester.pumpWidget(_app(
      PatientFlowScreen(connection: host, session: session),
    ));
    await tester.pumpAndSettle();
    expect(find.byType(WelcomeScreen), findsOneWidget);

    await tester.tap(find.text('利用開始'));
    await tester.pumpAndSettle();
    expect(find.byType(AuthMethodScreen), findsOneWidget);
    // Google/パスキーは未実装のため無効。パスキーは既定で非表示。
    expect(
      tester
          .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Googleで続ける'))
          .onPressed,
      isNull,
    );
    expect(find.text('パスキーで続ける'), findsNothing);

    await tester.tap(find.text('メールアドレスで続ける'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byType(TextFormField).at(0), 'a@example.test');
    await tester.enterText(find.byType(TextFormField).at(1), 'password123');
    final login = find.widgetWithText(FilledButton, 'ログイン');
    await tester.ensureVisible(login);
    await tester.tap(login);
    await tester.pumpAndSettle();
    expect(host.signedInEmail, 'a@example.test');
    session.dispose();
  });

  testWidgets('同意未完了の認証済みは同意画面を表示する', (tester) async {
    final host = _FakeHost(uid: 'uid-1');
    final session = PatientSessionState(
      (uid) async => me(uid, onboarding: 'legal_pending'),
    );
    var requirementsRequested = 0;
    await tester.pumpWidget(_app(
      PatientFlowScreen(
        connection: host,
        session: session,
        requirementsLoader: () async {
          requirementsRequested++;
          return ConsentRequirements(
            requiredConsents: const [
              'terms_of_service',
              'privacy_policy_ack',
              'health_data_collection',
            ],
            documentVersions: const {
              'terms_of_service': 'v1',
              'privacy_policy_ack': 'v1',
              'health_data_collection': 'v1',
            },
          );
        },
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('利用に必要な同意'), findsWidgets);
    expect(requirementsRequested, greaterThan(0));
    session.dispose();
  });

  testWidgets('プロフィール未完了の認証済みはプロフィール登録画面を表示する',
      (tester) async {
    final host = _FakeHost(uid: 'uid-1');
    final session = PatientSessionState(
      (uid) async => me(uid, onboarding: 'profile_pending'),
    );
    await tester.pumpWidget(_app(
      PatientFlowScreen(connection: host, session: session),
    ));
    await tester.pumpAndSettle();
    expect(find.byType(ProfileFormScreen), findsOneWidget);
    expect(find.text('プロフィール登録'), findsOneWidget);
    session.dispose();
  });

  testWidgets('完了済みの認証済みはホームを表示し問診開始で症状画面へ進む', (tester) async {
    final host = _FakeHost(uid: 'uid-1');
    final session = PatientSessionState((uid) async => me(uid));
    await tester.pumpWidget(_app(
      PatientFlowScreen(connection: host, session: session),
    ));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);

    await tester.tap(find.text('問診を始める'));
    await tester.pumpAndSettle();
    // 症状画面（PatientIntakeScreen startAuthenticated）へ遷移し、/me ゲート確認が走る。
    expect(find.byType(HomeScreen), findsNothing);
    session.dispose();
  });

  testWidgets('停止アカウントは利用不可画面を表示する', (tester) async {
    final host = _FakeHost(uid: 'uid-1');
    final session = PatientSessionState((uid) async => {
          ...me(uid),
          'accountStatus': 'suspended',
        });
    await tester.pumpWidget(_app(
      PatientFlowScreen(connection: host, session: session),
    ));
    await tester.pumpAndSettle();
    expect(find.text('このアカウントは利用できません'), findsOneWidget);
    session.dispose();
  });
}
