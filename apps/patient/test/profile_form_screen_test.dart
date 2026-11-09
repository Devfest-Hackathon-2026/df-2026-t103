import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_profile_form_preview.dart';

void main() {
  testWidgets('必須項目と任意項目を分けて表示する', (tester) async {
    await tester.pumpWidget(const ProfileFormPreview());
    expect(find.text('必須の項目'), findsOneWidget);
    expect(find.text('任意の項目'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, '姓（必須）'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, '持病（任意・なくても構いません）'), findsOneWidget);
  });

  testWidgets('未入力で登録すると必須エラーを表示する', (tester) async {
    await tester.pumpWidget(const ProfileFormPreview());
    final submit = find.widgetWithText(FilledButton, 'この内容で登録する');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(find.text('姓と名を入力してください'), findsWidgets);
    expect(find.text('7桁の郵便番号を入力してください'), findsOneWidget);
    expect(find.text('カタカナで入力してください'), findsWidgets);
  });

  testWidgets('カナと郵便番号の妥当性を検証する', (tester) async {
    await tester.pumpWidget(const ProfileFormPreview());
    await tester.enterText(find.widgetWithText(TextFormField, '姓カナ（必須）'), 'やまだ');
    await tester.enterText(find.widgetWithText(TextFormField, '郵便番号（必須・7桁）'), '123');
    final submit = find.widgetWithText(FilledButton, 'この内容で登録する');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(find.text('カタカナで入力してください'), findsWidgets);
    expect(find.text('7桁の郵便番号を入力してください'), findsOneWidget);
  });

  testWidgets('必須を正しく入力すると登録でき持病は任意', (tester) async {
    await tester.pumpWidget(const ProfileFormPreview());
    Future<void> fill(String label, String value) async {
      await tester.enterText(find.widgetWithText(TextFormField, label), value);
    }
    await fill('姓（必須）', '山田');
    await fill('名（必須）', '太郎');
    await fill('姓カナ（必須）', 'ヤマダ');
    await fill('名カナ（必須）', 'タロウ');
    await fill('生年月日（必須・例 1950-01-01）', '1950-01-01');
    await fill('電話番号（必須）', '09012345678');
    await fill('郵便番号（必須・7桁）', '100-0001');
    final prefecture = find.byType(DropdownButtonFormField<String>);
    await tester.ensureVisible(prefecture);
    await tester.tap(find.descendant(
      of: prefecture,
      matching: find.byType(DropdownButton<String>),
    ));
    await tester.pumpAndSettle();
    // メニューは遅延構築されるため、最後の Scrollable をスクロールして項目を現す。
    await tester.scrollUntilVisible(
      find.text('東京都'),
      300,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.tap(find.text('東京都'));
    await tester.pumpAndSettle();
    await fill('市区町村（必須）', '千代田区');
    await fill('番地・建物名など（必須）', '（架空）1-2-3');
    // 持病は空のまま
    final submit = find.widgetWithText(FilledButton, 'この内容で登録する');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(find.text('（デモ）入力内容は保存・送信されません。'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const ProfileFormPreview());
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'この内容で登録する'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
