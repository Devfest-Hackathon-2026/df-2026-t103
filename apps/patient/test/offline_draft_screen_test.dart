import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_offline_draft_preview.dart';

void main() {
  testWidgets('初期はオンライン表示', (tester) async {
    await tester.pumpWidget(const OfflineDraftPreview());
    expect(find.text('オンラインです。'), findsOneWidget);
  });

  testWidgets('オフラインにすると下書き保持の案内を出す', (tester) async {
    await tester.pumpWidget(const OfflineDraftPreview());
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    expect(find.text('オフラインです（機内モードなど）。'), findsOneWidget);
    expect(
      find.text('入力は端末に下書きとして保存され、接続が戻ると続きから再開できます。失われません。'),
      findsOneWidget,
    );
  });

  testWidgets('機内モード→復帰で回答（下書き）が失われない', (tester) async {
    await tester.pumpWidget(const OfflineDraftPreview());
    await tester.enterText(find.byType(TextField), 'サンプルの回答');
    await tester.pump();
    expect(find.text('下書きを端末に保存しました。'), findsOneWidget);
    // オフラインにして戻す
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    // 下書きが残っている
    expect(find.text('サンプルの回答'), findsOneWidget);
  });

  testWidgets('オフライン送信は送信待ちに積まれ、復帰でまとめて送信される', (tester) async {
    await tester.pumpWidget(const OfflineDraftPreview());
    await tester.enterText(find.byType(TextField), 'サンプルの回答');
    await tester.pump();
    // オフラインにする
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    // 送信 → 送信待ちへ
    final send = find.widgetWithText(FilledButton, '回答を送信する');
    await tester.ensureVisible(send);
    await tester.tap(send);
    await tester.pump();
    expect(find.text('送信待ち: 1件'), findsOneWidget);
    // 復帰 → フラッシュ
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    expect(find.text('送信待ち: 1件'), findsNothing);
    expect(find.text('接続が戻ったので、送信待ちの1件を送信しました（デモ）。'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const OfflineDraftPreview());
    await tester.ensureVisible(find.widgetWithText(FilledButton, '回答を送信する'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
