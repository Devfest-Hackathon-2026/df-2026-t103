import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/email_auth_form.dart';

const documents = RegistrationDocuments(
  terms: AuthLegalDocument(version: 'test-terms', body: '利用規約のテスト本文'),
  privacy: AuthLegalDocument(version: 'test-privacy', body: 'プライバシーのテスト本文'),
  health: AuthLegalDocument(version: 'test-health', body: '医療情報のテスト本文'),
);

Widget app({
  RegistrationDocuments? docs,
  EmailLogin? login,
  EmailRegister? register,
}) => MaterialApp(
  home: Scaffold(
    body: EmailAuthForm(documents: docs, onLogin: login, onRegister: register),
  ),
);

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pump();
}

Future<void> enterCredentials(WidgetTester tester) async {
  await tester.enterText(
    find.byType(TextFormField).at(0),
    'test@example.invalid',
  );
  await tester.enterText(find.byType(TextFormField).at(1), 'test1234');
}

void main() {
  testWidgets('文書が未接続または不完全なら登録できない', (tester) async {
    Future<EmailAuthResult> register(
      String e,
      String p,
      Map<String, Map<String, Object>> c,
    ) async => EmailAuthResult.success;
    await tester.pumpWidget(app(register: register));
    await tapVisible(tester, find.text('新規登録'));
    expect(find.text('正式な同意文書は未接続です。登録できません。'), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
    const incomplete = RegistrationDocuments(
      terms: AuthLegalDocument(version: '', body: '本文'),
      privacy: AuthLegalDocument(version: 'v', body: '本文'),
      health: AuthLegalDocument(version: 'v', body: '本文'),
    );
    await tester.pumpWidget(app(docs: incomplete, register: register));
    expect(find.byType(CheckboxListTile), findsNothing);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
  });

  testWidgets('狭画面200%で必須同意を個別に確認し二重送信しない', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final pending = Completer<EmailAuthResult>();
    var calls = 0;
    Map<String, Map<String, Object>>? submitted;
    await tester.pumpWidget(
      app(
        docs: documents,
        register: (e, p, consents) {
          calls++;
          submitted = consents;
          return pending.future;
        },
      ),
    );
    await tapVisible(tester, find.text('新規登録'));
    await enterCredentials(tester);
    for (var i = 0; i < 3; i++) {
      expect(
        tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
        isNull,
      );
      await tapVisible(tester, find.byType(CheckboxListTile).at(i));
    }
    await tapVisible(tester, find.text('登録する'));
    expect(calls, 1);
    expect(submitted!['terms_of_service'], {
      'accepted': true,
      'documentVersion': 'test-terms',
    });
    expect(
      submitted!['privacy_policy_ack']!['documentVersion'],
      'test-privacy',
    );
    expect(
      submitted!['health_data_collection']!['documentVersion'],
      'test-health',
    );
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
    await tester.tap(find.text('登録する'), warnIfMissed: false);
    expect(calls, 1);
    pending.complete(EmailAuthResult.failure);
    await tester.pump();
    expect(find.text('処理に失敗しました。もう一度お試しください。'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ログインの取消と例外を表示して再試行できる', (tester) async {
    var calls = 0;
    await tester.pumpWidget(
      app(
        login: (e, p) async {
          calls++;
          if (calls == 1) return EmailAuthResult.cancelled;
          throw StateError('sensitive details must not be shown');
        },
      ),
    );
    await enterCredentials(tester);
    await tapVisible(tester, find.text('ログインする'));
    expect(find.text('処理はキャンセルされました。'), findsOneWidget);
    await tapVisible(tester, find.text('ログインする'));
    expect(find.text('処理に失敗しました。もう一度お試しください。'), findsOneWidget);
    expect(find.textContaining('sensitive details'), findsNothing);
  });

  testWidgets('文書が差し替わると同意を取り直す', (tester) async {
    Future<EmailAuthResult> register(
      String e,
      String p,
      Map<String, Map<String, Object>> c,
    ) async => EmailAuthResult.success;
    await tester.pumpWidget(app(docs: documents, register: register));
    await tapVisible(tester, find.text('新規登録'));
    await tapVisible(tester, find.byType(CheckboxListTile).first);
    const replacement = RegistrationDocuments(
      terms: AuthLegalDocument(version: 'new', body: '新しい本文'),
      privacy: AuthLegalDocument(version: 'test-privacy', body: 'プライバシーのテスト本文'),
      health: AuthLegalDocument(version: 'test-health', body: '医療情報のテスト本文'),
    );
    await tester.pumpWidget(app(docs: replacement, register: register));
    expect(
      tester
          .widget<CheckboxListTile>(find.byType(CheckboxListTile).first)
          .value,
      isFalse,
    );
  });
}
