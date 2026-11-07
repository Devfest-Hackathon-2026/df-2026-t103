import 'package:flutter/material.dart';

/// 1 問＋原則 3 択の質問。すべて架空の表示例で、医学的な判断は含まない。
@immutable
class AiQuestion {
  const AiQuestion({required this.text, required this.choices});

  final String text;
  final List<String> choices;
}

/// next-question / answers API に接続しない AI 質問 Q&A（P-013）のプレビュー。
///
/// 1 画面 1 問・原則 3 択に加え、固定操作「わからない」「答えたくない」「前に戻る」を
/// 常に出す（docs/03 §3.5）。回答はメモリ上の下書きとして保持し、戻ると以降の回答は
/// 破棄する。中断して後で再開できる前提（FR-I06）。実際の AI 連携・保存は未接続。
class AiQuestionScreen extends StatefulWidget {
  const AiQuestionScreen({super.key});

  @override
  State<AiQuestionScreen> createState() => _AiQuestionScreenState();
}

class _AiQuestionScreenState extends State<AiQuestionScreen> {
  // 架空・非診断の表示例。医療用語や断定は避ける。
  static const _questions = [
    AiQuestion(
      text: 'その症状は、いつごろからありますか？',
      choices: ['数日以内', '1〜2週間くらい', '1か月以上'],
    ),
    AiQuestion(
      text: '症状は一日の中で変化しますか？',
      choices: ['朝がつらい', '夜がつらい', 'とくに変わらない'],
    ),
    AiQuestion(
      text: '今回いちばん気になることはどれですか？',
      choices: ['体のだるさ', '痛み', 'その他'],
    ),
  ];

  int _index = 0;
  final Map<int, String> _answers = {};

  bool get _done => _index >= _questions.length;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('問診Q&Aデモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: _done ? _buildDone(textTheme) : _buildQuestion(textTheme),
        ),
      ),
    );
  }

  Widget _buildQuestion(TextTheme textTheme) {
    final question = _questions[_index];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('これは表示例の質問です。医学的な判断は行いません。'),
        const Text('回答はこの端末の中だけに下書きとして保持されます。'),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: Text('質問 ${_index + 1} / あと数問（目安）', style: textTheme.titleMedium),
        ),
        const SizedBox(height: 16),
        Text(question.text, style: textTheme.titleLarge),
        const SizedBox(height: 16),
        for (final choice in question.choices)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: OutlinedButton(
              onPressed: () => _answer(choice),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(48, 48),
                textStyle: const TextStyle(fontSize: 20),
              ),
              child: Text(choice),
            ),
          ),
        const Divider(),
        // 固定操作（docs/03 §3.5）。
        TextButton(
          onPressed: () => _answer('わからない'),
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          child: const Text('わからない'),
        ),
        TextButton(
          onPressed: () => _answer('答えたくない'),
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          child: const Text('答えたくない'),
        ),
        TextButton(
          onPressed: _index > 0 ? _back : null,
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          child: const Text('前に戻る'),
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: _suspend,
          style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
          icon: const Icon(Icons.pause_circle_outline),
          label: const Text('中断して後で続ける'),
        ),
      ],
    );
  }

  Widget _buildDone(TextTheme textTheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text('ここまでの回答', style: textTheme.titleLarge),
        ),
        const SizedBox(height: 16),
        for (var i = 0; i < _questions.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text('Q${i + 1}. ${_questions[i].text}\n→ ${_answers[i] ?? '未回答'}'),
          ),
        const SizedBox(height: 16),
        const Text('要約（P-014）はこのデモでは未接続です。'),
        const ElevatedButton(onPressed: null, child: Text('要約へ進む')),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _back,
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          child: const Text('前の質問に戻って修正する'),
        ),
      ],
    );
  }

  void _answer(String choice) {
    setState(() {
      _answers[_index] = choice;
      _index++;
    });
  }

  void _back() {
    if (_index == 0) return;
    setState(() {
      _index--;
      // 戻ったら、その質問以降の回答は破棄する（依存質問の破棄）。
      _answers.removeWhere((key, value) => key >= _index);
    });
  }

  void _suspend() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('（デモ）下書きは端末に保持され、後で続けられます。')),
    );
  }
}
