import 'package:flutter/material.dart';

import 'patient_theme.dart';

/// 独立プレビュー: flutter run -t lib/demo_consent_preview.dart
void main() => runApp(const ConsentPreview());

class ConsentPreview extends StatelessWidget {
  const ConsentPreview({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '同意画面プレビュー',
    theme: buildPatientTheme(),
    home: const ConsentPreviewScreen(),
  );
}

class ConsentPreviewScreen extends StatefulWidget {
  const ConsentPreviewScreen({super.key});

  @override
  State<ConsentPreviewScreen> createState() => _ConsentPreviewScreenState();
}

class _ConsentPreviewScreenState extends State<ConsentPreviewScreen> {
  bool _reconsent = false;
  final List<bool> _checked = [false, false, false];

  static const _labels = [
    '利用規約の例を確認し、同意する',
    'プライバシー説明の例を確認し、同意する',
    '医療情報の取得目的の例を確認し、同意する',
  ];

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('同意画面プレビュー')),
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(
                _reconsent ? '再同意の表示例' : '初回同意の表示例',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 16),
              const Text(
                '架空のプレビューです。以下は正式な文書ではなく、法務未承認です。'
                '実際の同意には使用できません。診療情報を入力しないでください。',
              ),
              const SizedBox(height: 16),
              const Text(
                '文書の表示例（架空・版なし）\n'
                '利用規約、プライバシー説明、医療情報の取得目的の正式な本文は未接続です。'
                '医療機関への個別送信の同意は、これらとは別です。',
              ),
              const SizedBox(height: 16),
              for (var i = 0; i < _labels.length; i++)
                CheckboxListTile(
                  value: _checked[i],
                  title: Text('${_labels[i]}（必須の表示例）'),
                  controlAffinity: ListTileControlAffinity.leading,
                  onChanged: (value) => setState(() {
                    _checked[i] = value ?? false;
                  }),
                ),
              const SizedBox(height: 16),
              const Text('接続されていないため、同意の保存・利用開始はできません。入力内容は送信されません。'),
              const SizedBox(height: 8),
              const ElevatedButton(onPressed: null, child: Text('同意して進む')),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: () => setState(() {
                  _reconsent = !_reconsent;
                  _checked.fillRange(0, _checked.length, false);
                }),
                child: Text(_reconsent ? '初回同意の表示例へ' : '再同意の表示例へ'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
