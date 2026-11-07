import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_withdrawal_preview.dart';

void main() {
  testWidgets('申請前は影響・30日保留・取消期限を表示する', (tester) async {
    await tester.pumpWidget(const WithdrawalPreview());
    expect(find.text('退会の申請'), findsOneWidget);
    expect(find.text('・これまでの問診の記録が見られなくなります。'), findsOneWidget);
    expect(find.text('お申し込みから30日間は保留され、その間は退会を取り消せます。'), findsOneWidget);
    expect(find.textContaining('再認証'), findsOneWidget);
  });

  testWidgets('理解チェックまで申請できず、二重確認を経て申請できる', (tester) async {
    await tester.pumpWidget(const WithdrawalPreview());
    final request = find.widgetWithText(FilledButton, '退会を申請する');
    await tester.ensureVisible(request);
    expect(tester.widget<FilledButton>(request).onPressed, isNull);

    await tester.tap(find.text('退会による影響と、30日後に削除されることを理解しました。'));
    await tester.pump();
    expect(tester.widget<FilledButton>(request).onPressed, isNotNull);

    await tester.ensureVisible(request);
    await tester.tap(request);
    await tester.pumpAndSettle();
    expect(find.text('退会の最終確認'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '退会を申請する'));
    await tester.pumpAndSettle();
    expect(find.text('退会を受け付けました'), findsOneWidget);
  });

  testWidgets('申請後は機能停止を示し、取り消せる', (tester) async {
    await tester.pumpWidget(const WithdrawalPreview());
    await tester.tap(find.text('退会による影響と、30日後に削除されることを理解しました。'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '退会を申請する'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '退会を申請する'));
    await tester.pumpAndSettle();

    expect(find.text('退会の手続き中のため、問診などの通常の機能は停止しています。'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '退会を取り消す'));
    await tester.pumpAndSettle();
    expect(find.text('退会の申請'), findsOneWidget);
    expect(find.text('退会を取り消しました（デモ）。'), findsOneWidget);
  });

  testWidgets('申請の最終確認をやめると申請されない', (tester) async {
    await tester.pumpWidget(const WithdrawalPreview());
    await tester.tap(find.text('退会による影響と、30日後に削除されることを理解しました。'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '退会を申請する'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'やめる'));
    await tester.pumpAndSettle();
    expect(find.text('退会の申請'), findsOneWidget);
    expect(find.text('退会を受け付けました'), findsNothing);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const WithdrawalPreview());
    await tester.ensureVisible(find.widgetWithText(FilledButton, '退会を申請する'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
