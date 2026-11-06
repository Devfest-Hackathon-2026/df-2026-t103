import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_consent_preview.dart';

void main() {
  testWidgets('未選択でも全選択でも保存や進行はできない', (tester) async {
    await tester.pumpWidget(const ConsentPreview());
    expect(find.textContaining('架空のプレビュー'), findsOneWidget);
    expect(find.textContaining('法務未承認'), findsOneWidget);
    expect(
      tester
          .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
          .every((tile) => tile.value == false),
      isTrue,
    );

    for (final tile in find.byType(CheckboxListTile).evaluate().toList()) {
      final finder = find.byWidget(tile.widget);
      await tester.ensureVisible(finder);
      await tester.tap(finder);
      await tester.pump();
    }
    await tester.ensureVisible(find.text('同意して進む'));
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
    expect(find.textContaining('同意の保存・利用開始はできません'), findsOneWidget);
    expect(find.textContaining('完了しました'), findsNothing);
  });

  testWidgets('再同意の表示への切替で選択が引き継がれない', (tester) async {
    await tester.pumpWidget(const ConsentPreview());
    await tester.ensureVisible(find.byType(CheckboxListTile).first);
    await tester.tap(find.byType(CheckboxListTile).first);
    await tester.pump();
    await tester.ensureVisible(find.text('再同意の表示例へ'));
    await tester.tap(find.text('再同意の表示例へ'));
    await tester.pump();
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNull,
    );
    await tester.drag(find.byType(ListView), const Offset(0, 1000));
    await tester.pumpAndSettle();
    expect(find.text('再同意の表示例'), findsOneWidget);
    expect(
      tester
          .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
          .every((tile) => tile.value == false),
      isTrue,
    );
  });
}
