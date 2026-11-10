import 'package:flutter/material.dart';

/// 保存や送信を行わない症状入力の UI プレビュー。
class SymptomInputScreen extends StatefulWidget {
  const SymptomInputScreen({super.key});

  @override
  State<SymptomInputScreen> createState() => _SymptomInputScreenState();
}

class _SymptomInputScreenState extends State<SymptomInputScreen> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('症状入力プレビュー')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('プレビューには架空の内容のみ入力してください。保存も送信もしません。閉じると入力が失われます。'),
              const SizedBox(height: 24),
              TextField(
                controller: _controller,
                minLines: 4,
                maxLines: 8,
                maxLength: 1000,
                buildCounter:
                    (
                      context, {
                      required currentLength,
                      required isFocused,
                      maxLength,
                    }) {
                      return Semantics(
                        label: '$currentLength文字 / 最大$maxLength文字',
                        child: ExcludeSemantics(
                          child: Text('$currentLength/$maxLength'),
                        ),
                      );
                    },
                decoration: const InputDecoration(
                  labelText: '症状（必須）',
                  hintText: '例：2週間ほど、夕方になると体がだるい。日によって違います',
                  helperText: '1〜1000文字（暫定）',
                  helperMaxLines: 2,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 16),
              const Text('次の画面は未接続です。'),
              const SizedBox(height: 8),
              const ElevatedButton(onPressed: null, child: Text('次へ')),
            ],
          ),
        ),
      ),
    );
  }
}
