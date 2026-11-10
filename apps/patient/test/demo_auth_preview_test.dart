import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient/demo_auth_preview.dart';

void main() {
  testWidgets('ログインは未接続で成功しない', (tester) async {
    await tester.pumpWidget(const AuthPreview());
    expect(find.textContaining('実際のメールアドレスやパスワードを入力しない'), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('demo-email')),
      'example@example.invalid',
    );
    await tester.enterText(find.byKey(const Key('demo-password')), 'demo1234');
    await tester.ensureVisible(find.text('ログインを試す（デモ）'));
    await tester.tap(find.text('ログインを試す（デモ）'));
    await tester.pump();
    expect(find.text('送信先は未接続です。登録・ログインは行われていません。'), findsOneWidget);
    expect(find.text('認証画面デモ'), findsOneWidget);
  });

  testWidgets('仮項目は初期未選択で、全選択しても登録されない', (tester) async {
    await tester.pumpWidget(const AuthPreview());
    await tester.tap(find.text('新規登録'));
    await tester.pumpAndSettle();
    expect(find.textContaining('法的な同意は取得されません'), findsOneWidget);
    expect(
      tester
          .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
          .every((item) => item.value == false),
      isTrue,
    );
    final scrollable = find
        .descendant(
          of: find.byType(ListView),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(
      find.text('登録を試す（デモ）'),
      200,
      scrollable: scrollable,
    );
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    final labels = ['利用規約の確認（仮）', 'プライバシーの確認（仮）', '医療情報の取得目的の確認（仮）'];
    for (var i = 0; i < labels.length; i++) {
      final label = labels[i];
      await tester.scrollUntilVisible(
        find.text(label),
        i == 0 ? -200 : 200,
        scrollable: scrollable,
      );
      await tester.tap(find.text(label));
      await tester.pump();
    }
    await tester.scrollUntilVisible(
      find.text('登録を試す（デモ）'),
      200,
      scrollable: scrollable,
    );
    await tester.tap(find.text('登録を試す（デモ）'));
    await tester.pump();
    expect(find.text('送信先は未接続です。登録・ログインは行われていません。'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('ログイン'),
      -200,
      scrollable: scrollable,
    );
    await Scrollable.ensureVisible(
      tester.element(find.text('ログイン')),
      alignment: 0.5,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('ログイン'));
    await tester.pump();
    expect(find.text('送信先は未接続です。登録・ログインは行われていません。'), findsNothing);
  });
}
