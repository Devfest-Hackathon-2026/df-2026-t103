import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_hospital_search_preview.dart';

void main() {
  testWidgets('参加施設はラベルと運営確認日を表示する', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    expect(find.text('サンプル中央クリニック'), findsOneWidget);
    expect(find.text('このアプリで問診を受け取れる施設です。'), findsNWidgets(2));
    expect(find.text('運営確認日: 2026-10-30'), findsOneWidget);
  });

  testWidgets('非参加施設は場所の案内のみ（送信不可）を表示する', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    await tester.ensureVisible(find.text('場所の案内のみ（送信不可）'));
    expect(find.text('場所の案内のみ（送信不可）'), findsOneWidget);
    expect(find.text('サンプル総合病院'), findsOneWidget);
  });

  testWidgets('送信が受診受け入れを意味しない旨を必ず表示する', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    await tester.ensureVisible(
      find.text('問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。'),
    );
    expect(
      find.text('問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。'),
      findsOneWidget,
    );
  });

  testWidgets('住所・郵便番号の手入力欄がある', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    expect(find.byType(TextField), findsOneWidget);
    await tester.enterText(find.byType(TextField), '東京都千代田区');
    await tester.pump();
    expect(find.text('東京都千代田区'), findsOneWidget);
  });

  testWidgets('現在地ボタンは都度同意の説明ダイアログを開く', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    await tester.tap(find.widgetWithText(OutlinedButton, '現在地からさがす'));
    await tester.pumpAndSettle();
    expect(find.text('位置情報について'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, '閉じる'));
    await tester.pumpAndSettle();
    expect(find.text('位置情報について'), findsNothing);
  });

  testWidgets('施設選択・住所検索はデモでは未接続', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    for (final button in tester.widgetList<ElevatedButton>(
      find.byType(ElevatedButton),
    )) {
      expect(button.onPressed, isNull);
    }
  });

  testWidgets('施設選択ボタンに施設名を含む', (tester) async {
    await tester.pumpWidget(const HospitalSearchPreview());
    expect(
      find.widgetWithText(ElevatedButton, 'サンプル中央クリニックを選ぶ'),
      findsOneWidget,
    );
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const HospitalSearchPreview());
    await tester.ensureVisible(find.text('場所の案内のみ（送信不可）'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
