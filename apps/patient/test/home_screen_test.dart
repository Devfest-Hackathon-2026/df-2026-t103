import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_home_preview.dart';
import 'package:patient/home_screen.dart';

void main() {
  const labels = ['問診を始める', '薬を見る', 'これまでの問診', '通知', 'アカウント'];
  const otherLabels = ['薬を見る', 'これまでの問診', '通知', 'アカウント'];

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

  testWidgets('コールバック未指定のHomeScreenは従来どおり全導線が無効のまま', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: HomeScreen()));

    expect(find.text('画面の表示例です。各機能は未接続のため利用できません。'), findsOneWidget);
    expect(find.text('未接続'), findsNWidgets(labels.length));
    for (final label in labels) {
      final button = find.ancestor(
        of: find.text(label),
        matching: find.byType(OutlinedButton),
      );
      expect(tester.widget<OutlinedButton>(button).onPressed, isNull);
    }
  });

  testWidgets('onStartQuestionnaire指定時のみ問診導線だけが有効になる', (tester) async {
    var tapped = false;
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(onStartQuestionnaire: () => tapped = true),
      ),
    );

    // 有効になるのは問診導線だけで、他は未接続のまま。
    final startButton = find.ancestor(
      of: find.text('問診を始める'),
      matching: find.byType(OutlinedButton),
    );
    expect(tester.widget<OutlinedButton>(startButton).onPressed, isNotNull);
    for (final label in otherLabels) {
      final button = find.ancestor(
        of: find.text(label),
        matching: find.byType(OutlinedButton),
      );
      expect(tester.widget<OutlinedButton>(button).onPressed, isNull);
    }
    expect(find.text('未接続'), findsNWidgets(otherLabels.length));
    expect(
      find.text('画面の表示例です。問診を始められます。他の機能は未接続のため利用できません。'),
      findsOneWidget,
    );
    expect(find.text('画面の表示例です。各機能は未接続のため利用できません。'), findsNothing);

    await tester.ensureVisible(find.text('問診を始める'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('問診を始める'));
    await tester.pump();
    expect(tapped, isTrue);
  });

  testWidgets('有効な問診導線と無効な未接続導線を読み上げで区別する', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(home: HomeScreen(onStartQuestionnaire: () {})),
    );

    for (final label in otherLabels) {
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
          isEnabled: false,
        ),
      );
    }

    await tester.ensureVisible(find.text('問診を始める'));
    await tester.pumpAndSettle();
    expect(
      tester.getSemantics(find.ancestor(
        of: find.text('問診を始める'),
        matching: find.byType(OutlinedButton),
      )),
      isSemantics(
        label: '問診を始める',
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
      ),
    );

    semantics.dispose();
  });
}
