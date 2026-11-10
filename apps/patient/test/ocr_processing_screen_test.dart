import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_ocr_processing_preview.dart';

void main() {
  testWidgets('架空の不定進捗と未接続の操作を表示する', (tester) async {
    await tester.pumpWidget(const OcrProcessingPreview());

    expect(find.text('画面のデモ'), findsOneWidget);
    expect(find.text('これは架空の表示です。実際の写真の読み取りは行っていません。'), findsOneWidget);
    expect(find.text('写真を読み取っています（表示例）'), findsOneWidget);
    expect(
      tester
          .widget<CircularProgressIndicator>(
            find.byType(CircularProgressIndicator),
          )
          .value,
      isNull,
    );
    expect(find.text('進捗は表示例です。処理状態の保存や通知は行いません。'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(find.text('「あとで確認」はこのデモでは使えません。'), findsOneWidget);
    expect(find.textContaining('完了'), findsNothing);
  });

  testWidgets('狭画面と200%拡大でもスクロールして操作と説明に到達できる', (tester) async {
    tester.view.physicalSize = const Size(320, 480);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const OcrProcessingPreview());

    await tester.scrollUntilVisible(find.text('あとで確認（未接続）'), 200);
    expect(find.text('あとで確認（未接続）'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('「あとで確認」はこのデモでは使えません。'), 200);
    expect(tester.takeException(), isNull);
  });

  testWidgets('読み上げに表示例と未接続の操作が伝わる', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const OcrProcessingPreview());

    expect(find.bySemanticsLabel('写真を読み取っています（表示例）'), findsOneWidget);
    expect(find.bySemanticsLabel('あとで確認（未接続）'), findsOneWidget);
    expect(find.bySemanticsLabel('「あとで確認」はこのデモでは使えません。'), findsOneWidget);
    semantics.dispose();
  });
}
