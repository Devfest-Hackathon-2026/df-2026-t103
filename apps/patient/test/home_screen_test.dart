import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_home_preview.dart';

void main() {
  const labels = ['問診を始める', '薬を見る', 'これまでの問診', '通知', 'アカウント'];

  testWidgets('プレビューの各導線は未接続で操作できない', (tester) async {
    await tester.pumpWidget(const HomePreviewApp());

    expect(find.text('ホーム（プレビュー）'), findsOneWidget);
    expect(find.text('画面の表示例です。各機能は未接続のため利用できません。'), findsOneWidget);
    expect(find.text('未接続'), findsNWidgets(labels.length));
    for (final label in labels) {
      final button = find.ancestor(
        of: find.text(label),
        matching: find.byType(OutlinedButton),
      );
      expect(tester.widget<OutlinedButton>(button).onPressed, isNull);
    }
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('狭画面と200%文字拡大で全導線にスクロールできる', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const HomePreviewApp());
    for (final label in labels) {
      await tester.ensureVisible(find.text(label));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('各導線は読み上げで無効なボタンとして伝わる', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(const HomePreviewApp());
    for (final label in labels) {
      await tester.ensureVisible(find.text(label));
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(find.ancestor(
          of: find.text(label),
          matching: find.byType(OutlinedButton),
        )),
        matchesSemantics(
          label: '$label\n未接続',
          isButton: true,
          hasEnabledState: true,
        ),
      );
    }
    semantics.dispose();
  });
}
