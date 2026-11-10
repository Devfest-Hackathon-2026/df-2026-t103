import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/main.dart';
import 'package:patient/welcome_screen.dart';

void main() {
  testWidgets('サービスの説明と利用開始できない理由を表示する', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const PatientApp());

    expect(find.text('もしもし問診へようこそ'), findsOneWidget);
    expect(find.text('医療機関に伝える患者情報の整理を支援するサービスです。'), findsOneWidget);
    expect(find.text('診断・治療・受診予約は行いません。'), findsOneWidget);
    expect(find.textContaining('認証・同意・利用開始後の画面が未実装'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(
      tester.getSemantics(find.byType(FilledButton)),
      matchesSemantics(label: '利用開始', isButton: true, hasEnabledState: true),
    );
    await tester.tap(find.byType(FilledButton));
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(WelcomeScreen), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('狭い画面と200%文字倍率でもスクロールして内容を確認できる', (tester) async {
    tester.view.physicalSize = const Size(320, 480);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const PatientApp());

    final context = tester.element(find.text('診断・治療・受診予約は行いません。'));
    expect(MediaQuery.textScalerOf(context).scale(20), 40);
    expect(Theme.of(context).textTheme.bodyMedium?.fontSize, 20);

    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(find.text('利用開始'), 200);
    expect(find.textContaining('認証・同意・利用開始後の画面が未実装'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('患者テーマの文字サイズと配色が適用される', (WidgetTester tester) async {
    await tester.pumpWidget(const PatientApp());

    final context = tester.element(find.text('診断・治療・受診予約は行いません。'));
    final theme = Theme.of(context);
    expect(theme.textTheme.bodySmall?.fontSize, 20);
    expect(theme.textTheme.bodyMedium?.fontSize, 20);
    expect(theme.textTheme.bodyLarge?.fontSize, 20);
    expect(theme.textTheme.titleMedium?.fontSize, 24);
    expect(theme.textTheme.titleLarge?.fontSize, 28);
    expect(theme.textTheme.headlineLarge?.fontSize, 32);
    expect(theme.colorScheme, ColorScheme.fromSeed(seedColor: Colors.teal));
    expect(
      theme.colorScheme.onSurface.computeLuminance(),
      lessThan(theme.colorScheme.surface.computeLuminance()),
    );
    final body = tester.widget<RichText>(
      find.descendant(
        of: find.text('診断・治療・受診予約は行いません。'),
        matching: find.byType(RichText),
      ),
    );
    expect(body.text.style?.fontSize, 20);
  });
}
