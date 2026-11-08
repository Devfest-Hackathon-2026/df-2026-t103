import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_safety_confirm_preview.dart';
import 'package:patient/safety_confirm_screen.dart';

void main() {
  Future<void> answerAll(WidgetTester tester, SafetyAnswer answer) async {
    final label = {
      SafetyAnswer.yes: 'はい',
      SafetyAnswer.no: 'いいえ',
      SafetyAnswer.unknown: 'わからない',
    }[answer]!;
    final count = SafetyConfirmScreen.questions.length;
    for (var i = 0; i < count; i++) {
      final tile =
          find.widgetWithText(RadioListTile<SafetyAnswer>, label).at(i);
      await tester.ensureVisible(tile);
      await tester.tap(tile);
      await tester.pump();
    }
  }

  testWidgets('固定案内は回答前から常に表示される（緊急を除外しない安全線）', (tester) async {
    await tester.pumpWidget(const SafetyConfirmPreview());
    expect(
      find.textContaining('心配なときや急に悪くなったときは'),
      findsOneWidget,
    );
    expect(find.text('すべての項目にお答えいただくと次へ進めます。'), findsOneWidget);
  });

  testWidgets('医療監修前の暫定・網羅性を保証しない旨を明示する', (tester) async {
    await tester.pumpWidget(const SafetyConfirmPreview());
    expect(find.textContaining('医療監修前の暫定'), findsOneWidget);
    expect(find.textContaining('網羅していることは保証しません'), findsOneWidget);
  });

  testWidgets('すべて「いいえ」でも固定警告は出ず、緊急除外もしない', (tester) async {
    await tester.pumpWidget(const SafetyConfirmPreview());
    await answerAll(tester, SafetyAnswer.no);
    expect(find.text('気になる状態が選ばれています'), findsNothing);
    // 「問題ありません／緊急ではありません」のような除外表現は出さない。
    expect(find.text('回答を確認しました。次の問診へ進めます。'), findsOneWidget);
    expect(
      find.textContaining('心配なときや急に悪くなったときは'),
      findsOneWidget,
    );
  });

  testWidgets('赤旗の質問に「はい」で固定警告（NFR-04）を出す', (tester) async {
    await tester.pumpWidget(const SafetyConfirmPreview());
    final firstYes =
        find.widgetWithText(RadioListTile<SafetyAnswer>, 'はい').first;
    await tester.tap(firstYes);
    await tester.pump();
    expect(find.text('気になる状態が選ばれています'), findsOneWidget);
    expect(find.textContaining('119番'), findsOneWidget);
  });

  testWidgets('「わからない」も安全側に倒して固定警告を出す', (tester) async {
    await tester.pumpWidget(const SafetyConfirmPreview());
    final firstUnknown =
        find.widgetWithText(RadioListTile<SafetyAnswer>, 'わからない').first;
    await tester.tap(firstUnknown);
    await tester.pump();
    expect(find.text('気になる状態が選ばれています'), findsOneWidget);
  });

  testWidgets('次へは未接続（保存・送信しない）', (tester) async {
    await tester.pumpWidget(const SafetyConfirmPreview());
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    expect(
      tester
          .widget<ElevatedButton>(find.widgetWithText(ElevatedButton, '次へ'))
          .onPressed,
      isNull,
    );
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const SafetyConfirmPreview());
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
