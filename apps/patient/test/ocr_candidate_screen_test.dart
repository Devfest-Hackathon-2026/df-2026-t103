import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_ocr_candidate_preview.dart';

void main() {
  testWidgets('候補の名前・容量・用法・数量・処方日を表示する', (tester) async {
    await tester.pumpWidget(const OcrCandidatePreview());
    expect(find.text('読み取った候補（確認 0 / 2件）'), findsOneWidget);
    expect(find.text('サンプル降圧薬'), findsOneWidget);
    expect(find.text('容量: 5mg'), findsOneWidget);
    expect(find.text('用法: 1日1回 朝食後'), findsOneWidget);
    expect(find.text('数量: 28錠'), findsOneWidget);
    expect(find.text('処方日: 2026-10-20'), findsNWidgets(2));
  });

  testWidgets('全件確認するまで確定できず、自動確定しない', (tester) async {
    await tester.pumpWidget(const OcrCandidatePreview());
    final confirmFinder = find.widgetWithText(FilledButton, '確定する');
    expect(tester.widget<FilledButton>(confirmFinder).onPressed, isNull);

    await tester.ensureVisible(find.text('サンプル降圧薬の内容を確認しました'));
    await tester.tap(find.text('サンプル降圧薬の内容を確認しました'));
    await tester.pump();
    expect(find.text('読み取った候補（確認 1 / 2件）'), findsOneWidget);
    expect(tester.widget<FilledButton>(confirmFinder).onPressed, isNull);

    await tester.ensureVisible(find.text('サンプル胃薬の内容を確認しました'));
    await tester.tap(find.text('サンプル胃薬の内容を確認しました'));
    await tester.pump();
    expect(find.text('読み取った候補（確認 2 / 2件）'), findsOneWidget);
    expect(tester.widget<FilledButton>(confirmFinder).onPressed, isNotNull);

    await tester.ensureVisible(confirmFinder);
    await tester.tap(confirmFinder);
    await tester.pump();
    expect(find.text('（デモ）確定は保存・送信されません。'), findsOneWidget);
  });

  testWidgets('編集すると確認状態が解除され再確認を促す', (tester) async {
    await tester.pumpWidget(const OcrCandidatePreview());
    await tester.ensureVisible(find.text('サンプル降圧薬の内容を確認しました'));
    await tester.tap(find.text('サンプル降圧薬の内容を確認しました'));
    await tester.pump();
    expect(find.text('読み取った候補（確認 1 / 2件）'), findsOneWidget);

    await tester.ensureVisible(find.widgetWithText(TextButton, '編集').first);
    await tester.tap(find.widgetWithText(TextButton, '編集').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'サンプル別の薬');
    await tester.tap(find.widgetWithText(TextButton, '保存'));
    await tester.pumpAndSettle();

    expect(find.text('サンプル別の薬'), findsOneWidget);
    expect(find.text('読み取った候補（確認 0 / 2件）'), findsOneWidget);
  });

  testWidgets('抽出根拠の写真参照ダイアログを開ける', (tester) async {
    await tester.pumpWidget(const OcrCandidatePreview());
    await tester.ensureVisible(find.widgetWithText(TextButton, '写真を見る').first);
    await tester.tap(find.widgetWithText(TextButton, '写真を見る').first);
    await tester.pumpAndSettle();
    expect(find.text('抽出根拠（表示例）'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '閉じる'));
    await tester.pumpAndSettle();
    expect(find.text('抽出根拠（表示例）'), findsNothing);
  });

  testWidgets('編集・写真参照に読み上げ用ラベルがある', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const OcrCandidatePreview());
    expect(find.bySemanticsLabel('サンプル降圧薬を編集'), findsOneWidget);
    expect(find.bySemanticsLabel('サンプル降圧薬の抽出根拠の写真を見る'), findsOneWidget);
    semantics.dispose();
  });

  testWidgets('狭画面で200%拡大しても操作でき、初期は確定無効', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const OcrCandidatePreview());
    await tester.ensureVisible(find.text('確定する'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(tester.takeException(), isNull);
  });
}
