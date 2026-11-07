import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_medication_list_preview.dart';

void main() {
  testWidgets('服薬状況・登録元・確認日を明示して一覧表示する', (tester) async {
    await tester.pumpWidget(const MedicationListPreview());
    expect(find.text('お薬の一覧（3件）'), findsOneWidget);
    expect(find.text('サンプル降圧薬'), findsOneWidget);
    expect(find.text('服薬状況: 服用中'), findsOneWidget);
    expect(find.text('登録元: 写真から'), findsOneWidget);
    expect(find.text('確認日: 2026-10-15'), findsOneWidget);
  });

  testWidgets('追加導線は未接続', (tester) async {
    await tester.pumpWidget(const MedicationListPreview());
    final button = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(button.onPressed, isNull);
  });

  testWidgets('編集でメモリ上の名前と服薬状況を更新する', (tester) async {
    await tester.pumpWidget(const MedicationListPreview());
    await tester.tap(find.widgetWithText(TextButton, '編集').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'サンプル別の薬');
    await tester.tap(find.text('過去に服用'));
    await tester.pump();
    await tester.tap(find.widgetWithText(TextButton, '保存'));
    await tester.pumpAndSettle();
    expect(find.text('サンプル別の薬'), findsOneWidget);
    expect(find.text('サンプル降圧薬'), findsNothing);
  });

  testWidgets('削除は確認後にメモリ上の一覧から取り除く', (tester) async {
    await tester.pumpWidget(const MedicationListPreview());
    await tester.tap(find.widgetWithText(TextButton, '削除').first);
    await tester.pumpAndSettle();
    expect(find.text('削除の確認'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'やめる'));
    await tester.pumpAndSettle();
    expect(find.text('サンプル降圧薬'), findsOneWidget);
    expect(find.text('お薬の一覧（3件）'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, '削除').first);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '削除する'));
    await tester.pumpAndSettle();
    expect(find.text('サンプル降圧薬'), findsNothing);
    expect(find.text('お薬の一覧（2件）'), findsOneWidget);
  });

  testWidgets('編集ボタンに読み上げ用ラベルがある', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const MedicationListPreview());
    expect(find.bySemanticsLabel('サンプル降圧薬を編集'), findsOneWidget);
    expect(find.bySemanticsLabel('サンプル降圧薬を削除'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('狭画面で200%拡大しても操作でき、追加導線は無効', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const MedicationListPreview());
    await tester.ensureVisible(find.text('お薬を追加（写真から）'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(tester.takeException(), isNull);
  });
}
