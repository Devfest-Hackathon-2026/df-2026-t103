import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_notifications_preview.dart';

void main() {
  testWidgets('権限説明・PHI非含有の案内・受信通知を表示する', (tester) async {
    await tester.pumpWidget(const NotificationsPreview());
    expect(find.text('通知の受け取り'), findsOneWidget);
    expect(find.text('通知には、症状やお薬などの個人情報は含めません。'), findsOneWidget);
    expect(find.text('送信を受け付けました'), findsOneWidget);
    expect(find.text('問診の送信を受け付けました。アプリで状況を確認できます。'), findsOneWidget);
  });

  testWidgets('通知の受け取りを切り替えると拒否時の動作を案内する', (tester) async {
    await tester.pumpWidget(const NotificationsPreview());
    expect(find.text('通知を受け取ります。'), findsOneWidget);
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    expect(
      find.text('通知を受け取りません。許可しない場合も、状況はアプリの中で確認できます。'),
      findsOneWidget,
    );
  });

  testWidgets('通知タップはデモ遷移案内を出す', (tester) async {
    await tester.pumpWidget(const NotificationsPreview());
    await tester.tap(find.text('送信を受け付けました'));
    await tester.pump();
    expect(find.text('（デモ）「送信を受け付けました」を開く遷移は未接続です。'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const NotificationsPreview());
    await tester.ensureVisible(find.text('医療機関が確認しました'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
