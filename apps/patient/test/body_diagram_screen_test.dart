import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/body_diagram_screen.dart';
import 'package:patient/demo_body_diagram_preview.dart';

void main() {
  testWidgets('前面の部位を図から複数選択できる', (tester) async {
    await tester.pumpWidget(const BodyDiagramPreview());
    expect(find.text('未選択（部位が分からない場合はこのまま進めます）'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilterChip, '胸'));
    await tester.tap(find.widgetWithText(FilterChip, '左腕'));
    await tester.pump();
    expect(find.text('選択中: 前面: 左腕、前面: 胸'), findsOneWidget);
  });

  testWidgets('前面／背面を切り替えると図の部位が変わる', (tester) async {
    await tester.pumpWidget(const BodyDiagramPreview());
    expect(find.widgetWithText(FilterChip, '胸'), findsOneWidget);
    await tester.tap(find.widgetWithText(ChoiceChip, '背面'));
    await tester.pump();
    expect(find.widgetWithText(FilterChip, '背中'), findsOneWidget);
    expect(find.widgetWithText(FilterChip, '胸'), findsNothing);
  });

  testWidgets('文字による代替選択でも選べる', (tester) async {
    await tester.pumpWidget(const BodyDiagramPreview());
    await tester.tap(find.text('文字で選ぶ（図が使いにくいとき）'));
    await tester.pumpAndSettle();
    final item = find.widgetWithText(CheckboxListTile, '背面の背中');
    await tester.ensureVisible(item);
    await tester.tap(item);
    await tester.pump();
    expect(find.text('選択中: 背面: 背中'), findsOneWidget);
  });

  testWidgets('未選択でもスキップでき、次へは未接続', (tester) async {
    await tester.pumpWidget(const BodyDiagramPreview());
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    expect(
      tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, '次へ')).onPressed,
      isNull,
    );
    expect(find.text('未選択（部位が分からない場合はこのまま進めます）'), findsOneWidget);
  });

  testWidgets('狭画面で200%拡大しても例外なく表示できる', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const BodyDiagramPreview());
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
