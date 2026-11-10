import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_review_preview.dart';

void main() {
  testWidgets('要約・未回答・推測を区別して表示する', (tester) async {
    await tester.pumpWidget(const ReviewPreview());
    expect(find.text('問診票の確認'), findsOneWidget);
    expect(find.text('夕方になると体がだるい'), findsOneWidget);
    expect(find.text('未確認／未回答'), findsOneWidget);
    expect(find.text('（推定）仕事に集中しづらい'), findsOneWidget);
    expect(find.text('※ あなたの回答から推定した内容です。'), findsOneWidget);
    expect(find.text('※ まだ回答がありません。'), findsOneWidget);
  });

  testWidgets('確定前は修正導線があり送信導線はない', (tester) async {
    await tester.pumpWidget(const ReviewPreview());
    expect(find.widgetWithText(TextButton, 'この項目を直す'), findsWidgets);
    expect(find.widgetWithText(FilledButton, '送信先をさがす'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'この内容で確定する'), findsOneWidget);
  });

  testWidgets('確定すると不変表示になり修正導線が消え送信導線は未接続', (tester) async {
    await tester.pumpWidget(const ReviewPreview());
    final finalize = find.widgetWithText(FilledButton, 'この内容で確定する');
    await tester.ensureVisible(finalize);
    await tester.tap(finalize);
    await tester.pumpAndSettle();
    expect(find.text('確定の確認'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '確定する'));
    await tester.pumpAndSettle();

    expect(find.text('確定した問診票'), findsOneWidget);
    expect(find.text('この内容は確定済みで、変更できません。'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'この項目を直す'), findsNothing);
    // 内容は確定後も不変。
    expect(find.text('夕方になると体がだるい'), findsOneWidget);
    expect(find.text('（推定）仕事に集中しづらい'), findsOneWidget);
    final send = find.widgetWithText(FilledButton, '送信先をさがす');
    await tester.ensureVisible(send);
    expect(tester.widget<FilledButton>(send).onPressed, isNull);
  });

  testWidgets('確定をやめると確定されない', (tester) async {
    await tester.pumpWidget(const ReviewPreview());
    final finalize = find.widgetWithText(FilledButton, 'この内容で確定する');
    await tester.ensureVisible(finalize);
    await tester.tap(finalize);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'やめる'));
    await tester.pumpAndSettle();
    expect(find.text('問診票の確認'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'この内容で確定する'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const ReviewPreview());
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'この内容で確定する'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
