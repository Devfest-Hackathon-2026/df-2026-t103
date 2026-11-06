import 'package:flutter/material.dart';

/// 保存や画面遷移を行わない、身体部位のテキスト選択デモ。
class BodyLocationScreen extends StatefulWidget {
  const BodyLocationScreen({super.key});

  @override
  State<BodyLocationScreen> createState() => _BodyLocationScreenState();
}

class _BodyLocationScreenState extends State<BodyLocationScreen> {
  static const _locations = [
    '頭',
    '首',
    '胸',
    'お腹',
    '背中',
    '左腕',
    '右腕',
    '左膝',
    '右膝',
    '左脚',
    '右脚',
    '全身',
    'わからない',
  ];
  final Set<String> _selected = {};

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('部位選択デモ')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('架空のデモです。実際の患者情報は入力しないでください。'),
            const Text('選択はメモリ上のみで、保存されません。'),
            const Text('人体図は未実装です。テキストで部位を選べます。'),
            const SizedBox(height: 16),
            const Text('気になる部位を選んでください（複数選択可・未選択でも可）。'),
            const Text('左右は、患者本人から見た左右です。'),
            for (final location in _locations)
              CheckboxListTile(
                title: Text(location),
                value: _selected.contains(location),
                onChanged: (value) {
                  setState(() {
                    if (value == true) {
                      if (location == 'わからない') {
                        _selected.clear();
                      } else {
                        _selected.remove('わからない');
                      }
                      _selected.add(location);
                    } else {
                      _selected.remove(location);
                    }
                  });
                },
              ),
            Text(_selected.isEmpty ? '未選択' : '選択中: ${_selected.join('、')}'),
            const SizedBox(height: 16),
            const Text('API・次の画面への遷移は未接続です。'),
            const ElevatedButton(onPressed: null, child: Text('次へ')),
          ],
        ),
      ),
    );
  }
}
