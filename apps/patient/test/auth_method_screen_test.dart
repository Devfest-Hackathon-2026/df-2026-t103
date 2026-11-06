import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/auth_method_screen.dart';
import 'package:patient/demo_auth_method_preview.dart';
import 'package:patient/patient_theme.dart';

Widget _wrap(Widget child) =>
    MaterialApp(theme: buildPatientTheme(), home: child);

Finder _methodButton(String label) =>
    find.ancestor(of: find.text(label), matching: find.byType(OutlinedButton));

void main() {
  testWidgets('既定ではPasskeyを表示せず、読み上げにも出さない', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const AuthMethodPreviewApp());

    expect(find.text('ログイン方法を選ぶ'), findsOneWidget);
    expect(find.text('Googleで続ける'), findsOneWidget);
    expect(find.text('メールアドレスで続ける'), findsOneWidget);
    expect(find.text('パスキーで続ける'), findsNothing);
    expect(find.byIcon(Icons.fingerprint), findsNothing);
    expect(find.bySemanticsLabel(RegExp('パスキー')), findsNothing);
    semantics.dispose();
  });

  testWidgets('審査承認時だけPasskeyを表示する', (tester) async {
    await tester.pumpWidget(
      _wrap(AuthMethodScreen(passkeyEnabled: true, onMethodSelected: (_) {})),
    );

    expect(find.text('パスキーで続ける'), findsOneWidget);
  });

  testWidgets('選ばれた認証方式を呼び出し側へ通知する', (tester) async {
    final selected = <AuthMethod>[];
    await tester.pumpWidget(
      _wrap(
        AuthMethodScreen(passkeyEnabled: true, onMethodSelected: selected.add),
      ),
    );

    await tester.tap(find.text('Googleで続ける'));
    await tester.tap(find.text('メールアドレスで続ける'));
    await tester.tap(find.text('パスキーで続ける'));

    expect(selected, [AuthMethod.google, AuthMethod.email, AuthMethod.passkey]);
  });

  testWidgets('未接続時は各方式を無効にし、理由を表示する', (tester) async {
    await tester.pumpWidget(const AuthMethodPreviewApp());

    expect(find.textContaining('認証は未接続'), findsOneWidget);
    expect(find.text('未接続'), findsNWidgets(2));
    for (final label in ['Googleで続ける', 'メールアドレスで続ける']) {
      expect(
        tester.widget<OutlinedButton>(_methodButton(label)).onPressed,
        isNull,
      );
    }
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('狭い画面と200%文字拡大でもスクロールして全方式を確認できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

    await tester.pumpWidget(
      _wrap(AuthMethodScreen(passkeyEnabled: true, onMethodSelected: (_) {})),
    );

    expect(tester.takeException(), isNull);
    for (final label in ['Googleで続ける', 'メールアドレスで続ける', 'パスキーで続ける']) {
      await tester.scrollUntilVisible(find.text(label), 200);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    }
    await tester.scrollUntilVisible(find.text('認証後、必要な同意やプロフィール登録へ進みます。'), 200);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('見出し・ボタンが読み上げで伝わる', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const AuthMethodPreviewApp());

    expect(
      tester.getSemantics(find.text('ログイン方法を選ぶ')),
      matchesSemantics(label: 'ログイン方法を選ぶ', isHeader: true),
    );
    expect(
      tester.getSemantics(_methodButton('Googleで続ける')),
      matchesSemantics(
        label: 'Googleで続ける\n未接続',
        isButton: true,
        hasEnabledState: true,
      ),
    );
    semantics.dispose();
  });
}
