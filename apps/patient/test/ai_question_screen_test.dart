import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_ai_question_preview.dart';

void main() {
  testWidgets('1問3択と固定操作、質問番号を表示する', (tester) async {
    await tester.pumpWidget(const AiQuestionPreview());
    expect(find.text('質問 1 / あと数問（目安）'), findsOneWidget);
    expect(find.text('その症状は、いつごろからありますか？'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '数日以内'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'わからない'), findsOneWidget);
    expect(find.widgetWithText(TextButton, '答えたくない'), findsOneWidget);
    expect(find.widgetWithText(TextButton, '前に戻る'), findsOneWidget);
  });

  testWidgets('最初の質問では前に戻るが無効', (tester) async {
    await tester.pumpWidget(const AiQuestionPreview());
    await tester.ensureVisible(find.widgetWithText(TextButton, '前に戻る'));
    expect(
      tester.widget<TextButton>(find.widgetWithText(TextButton, '前に戻る')).onPressed,
      isNull,
    );
  });

  testWidgets('回答すると次の質問へ進み、戻ると元の質問に戻る', (tester) async {
    await tester.pumpWidget(const AiQuestionPreview());
    await tester.tap(find.widgetWithText(OutlinedButton, '数日以内'));
    await tester.pump();
    expect(find.text('質問 2 / あと数問（目安）'), findsOneWidget);
    expect(find.text('症状は一日の中で変化しますか？'), findsOneWidget);

    await tester.ensureVisible(find.widgetWithText(TextButton, '前に戻る'));
    await tester.tap(find.widgetWithText(TextButton, '前に戻る'));
    await tester.pump();
    expect(find.text('質問 1 / あと数問（目安）'), findsOneWidget);
  });

  testWidgets('「わからない」でも次へ進める', (tester) async {
    await tester.pumpWidget(const AiQuestionPreview());
    await tester.ensureVisible(find.widgetWithText(TextButton, 'わからない'));
    await tester.tap(find.widgetWithText(TextButton, 'わからない'));
    await tester.pump();
    expect(find.text('質問 2 / あと数問（目安）'), findsOneWidget);
  });

  testWidgets('全問回答すると回答一覧を表示し、要約へは未接続', (tester) async {
    await tester.pumpWidget(const AiQuestionPreview());
    await tester.tap(find.widgetWithText(OutlinedButton, '数日以内'));
    await tester.pump();
    await tester.tap(find.widgetWithText(OutlinedButton, '朝がつらい'));
    await tester.pump();
    await tester.tap(find.widgetWithText(OutlinedButton, 'その他'));
    await tester.pump();

    expect(find.text('ここまでの回答'), findsOneWidget);
    expect(find.textContaining('→ 数日以内'), findsOneWidget);
    expect(find.textContaining('→ その他'), findsOneWidget);
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '要約へ進む'));
    expect(
      tester
          .widget<ElevatedButton>(find.widgetWithText(ElevatedButton, '要約へ進む'))
          .onPressed,
      isNull,
    );
  });

  testWidgets('中断で下書き保持の案内を出す', (tester) async {
    await tester.pumpWidget(const AiQuestionPreview());
    await tester.ensureVisible(find.widgetWithText(OutlinedButton, '中断して後で続ける'));
    await tester.tap(find.widgetWithText(OutlinedButton, '中断して後で続ける'));
    await tester.pump();
    expect(find.text('（デモ）下書きは端末に保持され、後で続けられます。'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても操作でき例外が出ない', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const AiQuestionPreview());
    await tester.ensureVisible(find.widgetWithText(OutlinedButton, '中断して後で続ける'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
