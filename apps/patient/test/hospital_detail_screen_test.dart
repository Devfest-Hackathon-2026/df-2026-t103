import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_hospital_detail_preview.dart';
import 'package:patient/hospital_detail_screen.dart';
import 'package:patient/patient_theme.dart';

Widget _wrap(HospitalDetail detail) {
  return MaterialApp(
    theme: buildPatientTheme(),
    home: HospitalDetailScreen(detail: detail),
  );
}

void main() {
  testWidgets('参加施設は名称・所在地・参加・運営確認日・送信導線を表示する', (tester) async {
    await tester.pumpWidget(const HospitalDetailPreview());
    expect(find.text('サンプル中央クリニック'), findsOneWidget);
    expect(find.text('所在地: 東京都千代田区（架空）1-2-3'), findsOneWidget);
    expect(find.text('このアプリで問診を受け取れる施設です。'), findsOneWidget);
    expect(find.text('運営確認日: 2026-10-30'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'この施設へ送信へ進む'), findsOneWidget);
    expect(find.text('送信不可（場所の案内のみ）'), findsNothing);
  });

  testWidgets('送信導線はデモでは未接続', (tester) async {
    await tester.pumpWidget(const HospitalDetailPreview());
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
  });

  testWidgets('非参加施設は送信不可で送信導線を出さない', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const HospitalDetail(
          name: 'サンプル総合病院',
          address: '東京都港区（架空）7-8-9',
          participating: false,
        ),
      ),
    );
    expect(find.text('この施設は、このアプリでは問診を送信できません。場所の案内のみです。'), findsOneWidget);
    expect(find.text('送信不可（場所の案内のみ）'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('地図サービスの帰属表示と送信注意を表示する', (tester) async {
    await tester.pumpWidget(const HospitalDetailPreview());
    await tester.ensureVisible(find.text('Powered by Google'));
    expect(find.text('Powered by Google'), findsOneWidget);
    expect(
      find.text('問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。'),
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
    await tester.pumpWidget(const HospitalDetailPreview());
    await tester.ensureVisible(find.text('Powered by Google'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
