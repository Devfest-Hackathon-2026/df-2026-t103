import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_prescription_capture_preview.dart';

void main() {
  testWidgets('個人情報の説明と3つの取り込み方法を表示する', (tester) async {
    await tester.pumpWidget(const PrescriptionCapturePreview());
    expect(find.text('処方箋には、お名前や生年月日などの個人情報が含まれます。'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'カメラで撮影する'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, '写真から選ぶ'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'PDFを選ぶ'), findsOneWidget);
  });

  testWidgets('対応形式などの取り込み条件を表示する', (tester) async {
    await tester.pumpWidget(const PrescriptionCapturePreview());
    expect(find.text('・写真は JPEG・PNG、処方箋は PDF も使えます。'), findsOneWidget);
  });

  testWidgets('取り込み方法のタップはデモ案内を出す', (tester) async {
    await tester.pumpWidget(const PrescriptionCapturePreview());
    await tester.tap(find.widgetWithText(OutlinedButton, 'カメラで撮影する'));
    await tester.pump();
    expect(find.text('（デモ）カメラ からの取り込みは未接続です。'), findsOneWidget);
  });

  testWidgets('読み取りに進むは未接続', (tester) async {
    await tester.pumpWidget(const PrescriptionCapturePreview());
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '読み取りに進む'));
    expect(
      tester
          .widget<ElevatedButton>(find.widgetWithText(ElevatedButton, '読み取りに進む'))
          .onPressed,
      isNull,
    );
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const PrescriptionCapturePreview());
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '読み取りに進む'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
