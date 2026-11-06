import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_symptom_preview.dart';

void main() {
  testWidgets('空欄と長文の文字数を表示し、次へは常に無効', (tester) async {
    await tester.pumpWidget(const SymptomPreviewApp());
    expect(find.textContaining('架空の内容のみ'), findsOneWidget);
    expect(find.textContaining('保存も送信もしません'), findsOneWidget);
    expect(find.textContaining('閉じると入力が失われます'), findsOneWidget);
    expect(find.text('0/1000'), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );

    await tester.enterText(find.byType(TextField), 'あ' * 1001);
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text.length,
      1000,
    );
    expect(find.text('1000/1000'), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );

    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(const SymptomPreviewApp());
    expect(find.text('0/1000'), findsOneWidget);
  });

  testWidgets('狭画面と200%拡大でもスクロールして操作できる', (tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const SymptomPreviewApp());
    await tester.ensureVisible(find.byType(TextField));
    await tester.enterText(find.byType(TextField), '架空の内容');
    await tester.pump();
    await tester.ensureVisible(find.text('次へ'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('次へ'), findsOneWidget);
  });

  testWidgets('入力欄のラベルと文字数が読み上げ用に提供される', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const SymptomPreviewApp());
    expect(find.bySemanticsLabel(RegExp('症状（必須）')), findsWidgets);
    expect(find.bySemanticsLabel(RegExp('0.*1000')), findsWidgets);
    semantics.dispose();
  });
}
