import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:patient/main.dart';

void main() {
  testWidgets('デモ準備画面にタイトルと未実装である旨が表示される', (WidgetTester tester) async {
    await tester.pumpWidget(const PatientApp());

    // アプリタイトルが表示されていること（MaterialApp.title は描画面ではなく
    // OS タブ用の文書タイトルなので、画面上は AppBar の Text が 1 件）。
    expect(find.text('もしもし問診 患者アプリ'), findsOneWidget);
    expect(find.text('雛形デモ'), findsOneWidget);

    // 機能未実装であることが画面上で明示されていること。
    expect(find.text('この患者アプリの機能は未実装です。'), findsOneWidget);
  });

  testWidgets('文字拡大してもレイアウトが崩れない（overflow しない）', (WidgetTester tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const PatientApp());

    final context = tester.element(find.text('この患者アプリの機能は未実装です。'));
    expect(MediaQuery.textScalerOf(context).scale(20), 40);
    expect(Theme.of(context).textTheme.bodyMedium?.fontSize, 20);

    // 例外（RenderFlex overflow など）が発生しないこと。
    expect(tester.takeException(), isNull);

    // 拡大後も未実装の文言が表示されていること。
    expect(find.text('この患者アプリの機能は未実装です。'), findsOneWidget);
  });

  testWidgets('患者テーマの文字サイズと配色が適用される', (WidgetTester tester) async {
    await tester.pumpWidget(const PatientApp());

    final context = tester.element(find.text('この患者アプリの機能は未実装です。'));
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
        of: find.text('この患者アプリの機能は未実装です。'),
        matching: find.byType(RichText),
      ),
    );
    expect(body.text.style?.fontSize, 20);
  });
}
