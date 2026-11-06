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
    await tester.pumpWidget(
      const MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(2.0)),
        child: PatientApp(),
      ),
    );

    // 例外（RenderFlex overflow など）が発生しないこと。
    expect(tester.takeException(), isNull);

    // 拡大後も未実装の文言が表示されていること。
    expect(find.text('この患者アプリの機能は未実装です。'), findsOneWidget);
  });
}
