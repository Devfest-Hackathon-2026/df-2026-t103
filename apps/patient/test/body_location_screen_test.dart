import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_body_location_preview.dart';

void main() {
  testWidgets('複数選択と解除、未選択を表示する', (tester) async {
    await tester.pumpWidget(const BodyLocationPreview());
    expect(find.text('未選択'), findsOneWidget);
    await Scrollable.ensureVisible(
      tester.element(find.text('左腕')),
      alignment: 0.5,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('左腕'));
    await tester.tap(find.text('右腕'));
    await tester.pump();
    expect(find.text('選択中: 左腕、右腕'), findsOneWidget);
    await tester.tap(find.text('左腕'));
    await tester.pump();
    expect(find.text('選択中: 右腕'), findsOneWidget);
    await tester.tap(find.text('右腕'));
    await tester.pump();
    expect(find.text('未選択'), findsOneWidget);
  });

  testWidgets('わからないは具体的な部位と同時に選択されない', (tester) async {
    await tester.pumpWidget(const BodyLocationPreview());
    await tester.tap(find.text('頭'));
    await tester.ensureVisible(find.text('わからない'));
    await tester.tap(find.text('わからない'));
    await tester.pump();
    expect(find.text('選択中: わからない'), findsOneWidget);
    await tester.ensureVisible(find.text('頭'));
    await tester.tap(find.text('頭'));
    await tester.pump();
    expect(find.text('選択中: 頭'), findsOneWidget);
  });

  testWidgets('読み上げ用の選択状態が切り替わる', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const BodyLocationPreview());
    expect(
      tester.getSemantics(find.byType(Checkbox).first),
      matchesSemantics(
        hasCheckedState: true,
        hasSelectedState: true,
        label: '頭',
        isChecked: false,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
        isFocusable: true,
        hasFocusAction: true,
      ),
    );
    await tester.tap(find.text('頭'));
    await tester.pump();
    expect(
      tester.getSemantics(find.byType(Checkbox).first),
      matchesSemantics(
        hasCheckedState: true,
        hasSelectedState: true,
        label: '頭',
        isChecked: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
        isFocusable: true,
        hasFocusAction: true,
      ),
    );
    semantics.dispose();
  });

  testWidgets('狭画面で200%拡大しても操作でき、遷移は無効', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const BodyLocationPreview());
    await tester.ensureVisible(find.text('わからない'));
    await tester.tap(find.text('わからない'));
    await tester.pump();
    await tester.ensureVisible(find.text('次へ'));
    await tester.pumpAndSettle();
    expect(find.text('選択中: わからない'), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
    await tester.tap(find.text('次へ'));
    await tester.pumpAndSettle();
    expect(find.text('部位選択デモ'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
