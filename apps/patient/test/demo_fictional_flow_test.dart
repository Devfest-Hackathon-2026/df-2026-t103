import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_fictional_flow.dart';

const String safetyText =
    '架空の患者・施設・同意を使う非医療デモです。診断・予約・実際の送信は行いません。実際の患者情報は入力しないでください。';
const String consentReason =
    'このデモでは、同意の流れを確認するためにチェックが必要です。チェックするまで次へは進めません。';

void main() {
  Future<void> tapText(WidgetTester tester, String text) async {
    await tester.ensureVisible(find.text(text));
    await tester.tap(find.text(text));
    await tester.pumpAndSettle();
  }

  bool nextEnabled(WidgetTester tester) =>
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '次へ'))
          .onPressed !=
      null;

  void expectNoInputFields() {
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(TextFormField), findsNothing);
    expect(find.byType(EditableText), findsNothing);
  }

  testWidgets('架空の同意から模擬送信、戻る、再開始まで', (tester) async {
    await tester.pumpWidget(const FictionalDemoApp());
    expect(find.text(safetyText), findsOneWidget);
    expectNoInputFields();
    await tapText(tester, '問診を始める');
    expect(nextEnabled(tester), isFalse);
    await tapText(tester, '架空の同意を確認しました');
    await tapText(tester, '次へ');
    expect(find.text('部位選択デモ'), findsOneWidget);
    await tapText(tester, '次へ');
    expect(find.text('症状の例：昨日から頭が重い'), findsOneWidget);
    await tapText(tester, '次へ');
    expect(find.text('架空の送信先：みほん施設'), findsOneWidget);
    await tapText(tester, '戻る');
    expect(find.text('症状のサンプル'), findsOneWidget);
    await tapText(tester, '次へ');
    await tapText(tester, '模擬送信する');
    expect(
      find.text('実際には送信されておらず、施設にも届いていません。予約や診断も行っていません。'),
      findsOneWidget,
    );
    await tapText(tester, '最初からやり直す');
    await tapText(tester, '問診を始める');
    expect(nextEnabled(tester), isFalse);
  });

  testWidgets('同意チェックの理由を表示し、解除すると先へ進めない', (tester) async {
    await tester.pumpWidget(const FictionalDemoApp());
    await tapText(tester, '問診を始める');
    expect(find.text(consentReason), findsOneWidget);
    expect(nextEnabled(tester), isFalse);
    await tapText(tester, '架空の同意を確認しました');
    expect(nextEnabled(tester), isTrue);
    await tapText(tester, '架空の同意を確認しました');
    expect(nextEnabled(tester), isFalse);
    await tapText(tester, '架空の同意を確認しました');
    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    expect(find.text('症状のサンプル'), findsOneWidget);
  });

  testWidgets('全ステップで安全文言を表示し、入力欄を出さない', (tester) async {
    await tester.pumpWidget(const FictionalDemoApp());

    void expectSafeStep(String heading) {
      expect(find.text(heading), findsOneWidget);
      expect(find.text(safetyText), findsOneWidget);
      expectNoInputFields();
    }

    expectSafeStep('ホーム');
    await tapText(tester, '問診を始める');
    expectSafeStep('架空の同意');
    await tapText(tester, '架空の同意を確認しました');
    await tapText(tester, '次へ');
    expect(find.text('部位選択デモ'), findsOneWidget);
    await tapText(tester, '次へ');
    expectSafeStep('症状のサンプル');
    await tapText(tester, '次へ');
    expectSafeStep('模擬送信の確認');
    await tapText(tester, '模擬送信する');
    expectSafeStep('結果');
    expect(find.text('模擬送信が完了しました。'), findsOneWidget);
  });

  testWidgets('見出しはヘッダー、結果はライブリージョンとして設定される', (tester) async {
    await tester.pumpWidget(const FictionalDemoApp());

    Semantics heading() =>
        tester.widget<Semantics>(find.byKey(const Key('demo-step-heading')));

    expect(heading().properties.header, isTrue);
    await tapText(tester, '問診を始める');
    expect(heading().properties.header, isTrue);
    await tapText(tester, '架空の同意を確認しました');
    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    await tapText(tester, '模擬送信する');

    final result = tester.widget<Semantics>(
      find.byKey(const Key('demo-result-live-region')),
    );
    expect(result.properties.liveRegion, isTrue);
    expect(result.container, isTrue);
  });

  testWidgets('ステップ変更、戻る、再開始でスクロール位置が先頭に戻る', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const FictionalDemoApp());

    final flowScrollController = tester
        .widget<SingleChildScrollView>(
          find.byKey(const Key('demo-flow-scroll')),
        )
        .controller!;
    final scrollable = find.descendant(
      of: find.byKey(const Key('demo-flow-scroll')),
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is Scrollable && widget.controller == flowScrollController,
      ),
    );
    expect(scrollable, findsOneWidget);

    double offset() => tester.state<ScrollableState>(scrollable).position.pixels;

    Future<void> scrollDown() async {
      // The outer demo scroll view also contains the home's own scroll view.
      // Start outside the home's viewport so this gesture targets the demo.
      await tester.dragFrom(const Offset(312, 500), const Offset(0, -250));
      await tester.pumpAndSettle();
      expect(offset(), greaterThan(0));
    }

    void expectTop() => expect(offset(), moreOrLessEquals(0, epsilon: 0.1));

    await scrollDown();
    await tapText(tester, '問診を始める');
    expectTop();

    await tapText(tester, '架空の同意を確認しました');
    await scrollDown();
    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    expectTop();

    await scrollDown();
    await tapText(tester, '戻る');
    expectTop();

    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    await scrollDown();
    await tapText(tester, '模擬送信する');
    expectTop();

    await scrollDown();
    await tapText(tester, '最初からやり直す');
    expectTop();

    await tapText(tester, '問診を始める');
    expect(nextEnabled(tester), isFalse);
  });

  testWidgets('狭画面と文字拡大でも操作できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const FictionalDemoApp());
    await tapText(tester, '問診を始める');
    await tapText(tester, '架空の同意を確認しました');
    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    await tapText(tester, '次へ');
    await tapText(tester, '模擬送信する');
    await tapText(tester, '最初からやり直す');
    expect(tester.takeException(), isNull);
  });
}
