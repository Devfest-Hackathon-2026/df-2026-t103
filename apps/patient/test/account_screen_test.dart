import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_account_preview.dart';

void main() {
  testWidgets('プロフィール・認証設定・同意履歴・退会導線を表示する', (tester) async {
    await tester.pumpWidget(const AccountPreview());
    expect(find.text('プロフィール'), findsOneWidget);
    expect(find.text('認証の設定'), findsOneWidget);
    expect(find.text('同意の履歴'), findsOneWidget);
    expect(find.text('・利用規約 v1.0（2026-10-01 に同意）'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '退会の手続きへ'), findsOneWidget);
  });

  testWidgets('機微操作の再認証の案内を表示する', (tester) async {
    await tester.pumpWidget(const AccountPreview());
    expect(find.textContaining('再認証'), findsOneWidget);
  });

  testWidgets('パスワード変更のタップはデモ案内を出す', (tester) async {
    await tester.pumpWidget(const AccountPreview());
    final button = find.widgetWithText(OutlinedButton, 'パスワードを変更・再設定する');
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pump();
    expect(find.text('（デモ）パスワードの変更・再設定 は未接続です。'), findsOneWidget);
  });

  testWidgets('退会導線のタップはデモ案内を出す', (tester) async {
    await tester.pumpWidget(const AccountPreview());
    final button = find.widgetWithText(OutlinedButton, '退会の手続きへ');
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pump();
    expect(find.text('（デモ）退会の手続き は未接続です。'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const AccountPreview());
    await tester.ensureVisible(find.widgetWithText(OutlinedButton, '退会の手続きへ'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
