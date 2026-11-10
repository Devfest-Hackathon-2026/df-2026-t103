import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_delivery_status_preview.dart';
import 'package:patient/delivery_status_screen.dart';
import 'package:patient/patient_theme.dart';

void main() {
  final samples = {
    DemoDeliveryStatus.created: ('受付済み', '送信を受け付けた状態のサンプルです。まだ配送済みではありません。'),
    DemoDeliveryStatus.delivered: (
      '配送済み',
      '施設の受信箱に反映された状態のサンプルです。施設が確認したことは示しません。',
    ),
    DemoDeliveryStatus.acknowledged: (
      '施設確認',
      '施設が確認した状態のサンプルです。医師が確認したことは示しません。',
    ),
    DemoDeliveryStatus.failed: ('失敗', '送信の処理に失敗した状態のサンプルです。配送されたことは示しません。'),
  };

  for (final entry in samples.entries) {
    testWidgets('${entry.value.$1}を架空の状態として区別する', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildPatientTheme(),
          home: DeliveryStatusScreen(
            status: entry.key,
            onStatusChanged: (_) {},
          ),
        ),
      );
      expect(find.text('架空サンプル'), findsOneWidget);
      expect(find.text('サンプルの状態：${entry.value.$1}'), findsOneWidget);
      expect(find.text(entry.value.$2), findsOneWidget);
      expect(find.text('表示は架空の状態です。実際の送信・配送や状況確認は行いません。'), findsOneWidget);
      expect(
        find.text('問診票の送信は、診察や予約の確定、医師の確認、受診の受入れを意味しません。'),
        findsOneWidget,
      );
    });
  }

  testWidgets('プレビューは架空状態を切り替えられる', (tester) async {
    await tester.pumpWidget(const DeliveryStatusPreview());
    await tester.ensureVisible(find.text('サンプル：失敗'));
    await tester.tap(find.text('サンプル：失敗'));
    await tester.pumpAndSettle();
    expect(find.text('サンプルの状態：失敗'), findsOneWidget);
    expect(find.text('サンプルの状態：受付済み'), findsNothing);
  });

  for (final (keyName, key) in [
    ('Space', LogicalKeyboardKey.space),
    ('Enter', LogicalKeyboardKey.enter),
  ]) {
    testWidgets('Tabで実際にフォーカスした状態ボタンを$keyNameで選択できる', (tester) async {
      await tester.pumpWidget(const DeliveryStatusPreview());

      final target = find.text('サンプル：失敗');
      final targetFocus = Focus.of(tester.element(target));
      var focused = false;
      for (var i = 0; i < 12 && !focused; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        focused = targetFocus.hasPrimaryFocus;
      }
      expect(targetFocus.hasPrimaryFocus, isTrue);
      expect(find.text('サンプルの状態：受付済み'), findsOneWidget);

      await tester.sendKeyEvent(key);
      await tester.pumpAndSettle();

      expect(find.text('サンプルの状態：失敗'), findsOneWidget);
      expect(find.text('サンプルの状態：受付済み'), findsNothing);
    });
  }

  for (final semanticsEnabled in [false, true]) {
    for (final (keyName, key) in [
      ('Space', LogicalKeyboardKey.space),
      ('Enter', LogicalKeyboardKey.enter),
    ]) {
      testWidgets('semantics=$semanticsEnabled で失敗からTabと$keyNameで受付済みに戻る', (
        tester,
      ) async {
        await tester.pumpWidget(const DeliveryStatusPreview());
        expect(tester.binding.semanticsEnabled, semanticsEnabled);

        Future<void> focusByTab(String label) async {
          final target = find.text('サンプル：$label');
          for (var i = 0; i < 16; i++) {
            await tester.sendKeyEvent(LogicalKeyboardKey.tab);
            await tester.pumpAndSettle();
            if (Focus.of(tester.element(target)).hasPrimaryFocus) return;
          }
          expect(Focus.of(tester.element(target)).hasPrimaryFocus, isTrue);
        }

        await focusByTab('失敗');
        await tester.sendKeyEvent(key);
        await tester.pumpAndSettle();
        expect(find.text('サンプルの状態：失敗'), findsOneWidget);

        // 状態更新後の実フォーカスを、Tab だけで受付済みに移動する。
        await focusByTab('受付済み');
        expect(find.text('サンプルの状態：失敗'), findsOneWidget);
        await tester.sendKeyEvent(key);
        await tester.pumpAndSettle();
        expect(find.text('サンプルの状態：受付済み'), findsOneWidget);
        expect(find.text('サンプルの状態：失敗'), findsNothing);
      }, semanticsEnabled: semanticsEnabled);
    }
  }

  testWidgets('狭い画面と200%文字拡大でもスクロールして全状態を表示できる', (tester) async {
    await tester.binding.setSurfaceSize(const Size(320, 568));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const DeliveryStatusPreview());
    expect(
      MediaQuery.textScalerOf(tester.element(find.text('架空サンプル'))).scale(20),
      40,
    );
    for (final label in ['受付済み', '配送済み', '施設確認', '失敗']) {
      await tester.ensureVisible(find.text('サンプル：$label'));
      await tester.tap(find.text('サンプル：$label'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('サンプルの状態：$label'));
      expect(find.text('サンプルの状態：$label'), findsOneWidget);
      expect(tester.takeException(), isNull);
    }
  });
}
