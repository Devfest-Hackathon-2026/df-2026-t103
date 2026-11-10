import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/body_location_screen.dart';
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

  testWidgets('callbackがない既定画面は未接続表示のまま次へは無効', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: BodyLocationScreen()));

    expect(find.text('API・次の画面への遷移は未接続です。'), findsOneWidget);
    expect(
      find.text('架空デモの接続点です。選択結果をメモリ上で次へ渡します（保存・送信なし）。'),
      findsNothing,
    );
    expect(find.byType(ElevatedButton), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
  });

  testWidgets('callback指定時のみ次へが有効になり選択結果のコピーを渡す', (tester) async {
    final received = <List<String>>[];
    await tester.pumpWidget(
      MaterialApp(home: BodyLocationScreen(onNext: received.add)),
    );

    expect(find.text('API・次の画面への遷移は未接続です。'), findsNothing);
    expect(
      find.text('架空デモの接続点です。選択結果をメモリ上で次へ渡します（保存・送信なし）。'),
      findsOneWidget,
    );
    expect(find.text('選択はメモリ上のみで、保存されません。'), findsOneWidget);
    expect(find.byType(ElevatedButton), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNotNull,
    );

    await tester.ensureVisible(find.text('左腕'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('左腕'));
    await tester.tap(find.text('右腕'));
    await tester.pump();
    expect(find.text('選択中: 左腕、右腕'), findsOneWidget);

    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pump();

    expect(received, hasLength(1));
    expect(received.single, ['左腕', '右腕']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('渡した引数は画面の選択状態と独立している', (tester) async {
    final received = <List<String>>[];
    await tester.pumpWidget(
      MaterialApp(home: BodyLocationScreen(onNext: received.add)),
    );

    await tester.ensureVisible(find.text('頭'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('頭'));
    await tester.tap(find.text('首'));
    await tester.pump();
    expect(find.text('選択中: 頭、首'), findsOneWidget);

    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pump();
    expect(received.single, ['頭', '首']);

    // 画面側の選択を変更しても、渡したリストは変わらない。
    await tester.ensureVisible(find.text('頭'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('頭'));
    await tester.pump();
    expect(find.text('選択中: 首'), findsOneWidget);
    expect(received.single, ['頭', '首']);

    // 渡したリストを書き換えても、画面の選択は変わらない。
    received.single.clear();
    await tester.tap(find.text('胸'));
    await tester.pump();
    expect(find.text('選択中: 首、胸'), findsOneWidget);
    expect(received.single, isEmpty);
  });

  testWidgets('未選択でも次へ進め、空の選択結果を渡す', (tester) async {
    final received = <List<String>>[];
    await tester.pumpWidget(
      MaterialApp(home: BodyLocationScreen(onNext: received.add)),
    );
    expect(find.text('未選択'), findsOneWidget);

    await tester.ensureVisible(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ElevatedButton, '次へ'));
    await tester.pump();

    expect(received, hasLength(1));
    expect(received.single, isEmpty);
    expect(find.text('未選択'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('読み上げに次への有効・無効が伝わる', (tester) async {
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(const MaterialApp(home: BodyLocationScreen()));
    await tester.ensureVisible(find.byType(ElevatedButton));
    await tester.pumpAndSettle();
    expect(
      tester.getSemantics(find.byType(ElevatedButton)),
      matchesSemantics(label: '次へ', isButton: true, hasEnabledState: true),
    );

    await tester.pumpWidget(
      MaterialApp(home: BodyLocationScreen(onNext: (_) {})),
    );
    expect(
      tester.getSemantics(find.byType(ElevatedButton)),
      isSemantics(
        label: '次へ',
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
      ),
    );
    semantics.dispose();
  });
}
