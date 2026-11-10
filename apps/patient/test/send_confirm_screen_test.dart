import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_send_confirm_preview.dart';

void main() {
  testWidgets('送信先・送信内容・提供目的を明示する', (tester) async {
    await tester.pumpWidget(const SendConfirmPreview());
    expect(find.text('送信先'), findsOneWidget);
    expect(find.text('サンプル中央クリニック'), findsOneWidget);
    expect(find.text('送信する内容'), findsOneWidget);
    expect(find.text('・問診票（あなたの回答の要約）'), findsOneWidget);
    expect(find.text('提供する目的'), findsOneWidget);
    expect(
      find.text('選んだ医療機関に、あなたの問診内容を伝えるために送信します。'),
      findsOneWidget,
    );
  });

  testWidgets('個別同意を取るまで送信できず、同意後に送信できる', (tester) async {
    await tester.pumpWidget(const SendConfirmPreview());
    final sendButton = find.widgetWithText(FilledButton, 'この内容で送信する');
    await tester.ensureVisible(sendButton);
    expect(tester.widget<FilledButton>(sendButton).onPressed, isNull);

    final consent =
        find.text('上記の内容を、この医療機関に送信することに同意します（必須）。');
    await tester.ensureVisible(consent);
    await tester.tap(consent);
    await tester.pump();
    expect(tester.widget<FilledButton>(sendButton).onPressed, isNotNull);

    await tester.ensureVisible(sendButton);
    await tester.tap(sendButton);
    await tester.pump();
    expect(find.text('（デモ）送信は行いません。'), findsOneWidget);
  });

  testWidgets('送信するお薬を個別に選べる', (tester) async {
    await tester.pumpWidget(const SendConfirmPreview());
    final tile = find.widgetWithText(CheckboxListTile, 'サンプル降圧薬');
    await tester.ensureVisible(tile);
    expect(tester.widget<CheckboxListTile>(tile).value, isTrue);
    await tester.tap(tile);
    await tester.pump();
    expect(tester.widget<CheckboxListTile>(tile).value, isFalse);
  });

  testWidgets('送信が受診受け入れを意味しない旨を表示する', (tester) async {
    await tester.pumpWidget(const SendConfirmPreview());
    await tester.ensureVisible(
      find.text('問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。'),
    );
    expect(
      find.text('問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。'),
      findsOneWidget,
    );
  });

  testWidgets('狭画面で200%拡大しても操作でき、初期は送信無効', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const SendConfirmPreview());
    final sendButton = find.widgetWithText(FilledButton, 'この内容で送信する');
    await tester.ensureVisible(sendButton);
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(sendButton).onPressed, isNull);
    expect(tester.takeException(), isNull);
  });
}
