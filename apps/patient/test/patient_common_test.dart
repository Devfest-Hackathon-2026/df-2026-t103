import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_common_catalog_preview.dart';
import 'package:patient/patient_common.dart';
import 'package:patient/patient_theme.dart';

Widget _host(Widget child) =>
    MaterialApp(theme: buildPatientTheme(), home: Scaffold(body: child));

void main() {
  testWidgets('各状態が見出しと説明で表示される', (tester) async {
    await tester.pumpWidget(_host(
      const PatientStateView(status: PatientStatus.error),
    ));
    expect(find.text('うまくいきませんでした'), findsOneWidget);
    expect(find.text('まだ送信できていません。もう一度試せます。'), findsOneWidget);
  });

  testWidgets('loading はプログレスを出し再試行は出さない', (tester) async {
    await tester.pumpWidget(_host(
      const PatientStateView(status: PatientStatus.loading),
    ));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'もう一度試す'), findsNothing);
  });

  testWidgets('エラーで再試行コールバックが呼ばれる', (tester) async {
    var tapped = 0;
    await tester.pumpWidget(_host(
      PatientStateView(status: PatientStatus.error, onRetry: () => tapped++),
    ));
    await tester.tap(find.widgetWithText(FilledButton, 'もう一度試す'));
    await tester.pump();
    expect(tapped, 1);
  });

  testWidgets('無効な主要ボタンは押せない', (tester) async {
    await tester.pumpWidget(_host(
      const PatientPrimaryButton(label: '次へ', onPressed: null),
    ));
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
  });

  testWidgets('医療行為でない共通文言を表示する', (tester) async {
    await tester.pumpWidget(_host(const NotMedicalNotice()));
    expect(
      find.text('このサービスは、診断・治療・受診予約を行いません。医療行為ではありません。'),
      findsOneWidget,
    );
  });

  testWidgets('カタログが全状態・部品を列挙し、200%拡大でも例外が出ない', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const CommonCatalogPreview());
    await tester.pumpAndSettle();
    expect(find.text('状態: 読み込み中'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('共通文言: 医療行為でない'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('共通文言: 医療行為でない'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
