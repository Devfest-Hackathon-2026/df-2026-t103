import 'package:flutter/material.dart';

/// 固定質問の回答。「わからない」は安全側に倒し、危険兆候として扱う。
enum SafetyAnswer { yes, no, unknown }

/// 安全に関する確認（P-012）の固定質問。AIは関与せず、順序も内容も固定。
///
/// [dangerOnYes] / [dangerOnUnknown] は「固定ルール」に当たり、該当時に固定警告を
/// 出す唯一の根拠（docs/03 §2 P-012、docs/06 §5、NFR-04）。この画面はいかなる
/// 回答でも「緊急ではない」と伝えて緊急を除外しない（固定ルール以外で緊急除外しない）。
class SafetyQuestion {
  const SafetyQuestion({
    required this.id,
    required this.text,
    this.dangerOnYes = true,
    this.dangerOnUnknown = true,
  });

  final String id;
  final String text;
  final bool dangerOnYes;
  final bool dangerOnUnknown;

  bool isDanger(SafetyAnswer answer) {
    switch (answer) {
      case SafetyAnswer.yes:
        return dangerOnYes;
      case SafetyAnswer.unknown:
        return dangerOnUnknown;
      case SafetyAnswer.no:
        return false;
    }
  }
}

/// symptoms API に接続しない安全確認（P-012）のプレビュー。
///
/// 医療監修対象の固定質問に「はい／いいえ／わからない」の原則3択で答える。回答に
/// かかわらず緊急を除外せず、固定の相談・受診案内を常に示す。固定ルール（赤旗の
/// 質問に「はい」または「わからない」）に該当した場合のみ、固定警告を追加で表示する
/// （docs/03 §2 P-012、docs/06 §5、NFR-04、FR-I02）。質問・警告の確定文言は医療
/// 監修後に差し替える前提の暫定表記。回答はメモリ上のみで、保存・送信は未接続。
class SafetyConfirmScreen extends StatefulWidget {
  const SafetyConfirmScreen({super.key});

  /// 医療監修前の暫定の固定質問。確定文言・網羅性は監修で差し替える（RISK-02）。
  static const questions = <SafetyQuestion>[
    SafetyQuestion(
      id: 'Q1',
      text: '今、我慢できないほどの強い痛みや急な悪化がありますか',
    ),
    SafetyQuestion(
      id: 'Q2',
      text: '息がとても苦しい、または意識がもうろうとすることがありますか',
    ),
    SafetyQuestion(
      id: 'Q3',
      text: '今回の症状について、すでに救急や医療機関から指示を受けていますか',
    ),
  ];

  @override
  State<SafetyConfirmScreen> createState() => _SafetyConfirmScreenState();
}

class _SafetyConfirmScreenState extends State<SafetyConfirmScreen> {
  final Map<String, SafetyAnswer> _answers = {};

  bool get _allAnswered =>
      SafetyConfirmScreen.questions.every((q) => _answers.containsKey(q.id));

  bool get _anyDanger => SafetyConfirmScreen.questions.any((q) {
        final a = _answers[q.id];
        return a != null && q.isDanger(a);
      });

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('安全に関する確認デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。回答はメモリ上のみで、保存も送信もされません。'),
              const SizedBox(height: 8),
              const Text(
                'この確認は医療行為ではなく、診断や救急の判断をするものではありません。'
                '当てはまる項目がなくても、緊急ではないと判断するものではありません。',
              ),
              const SizedBox(height: 8),
              const Text(
                '質問と警告の文言は医療監修前の暫定です。確認する危険兆候のすべてを'
                '網羅していることは保証しません。',
              ),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text('安全に関する確認', style: textTheme.titleLarge),
              ),
              const SizedBox(height: 12),
              for (final q in SafetyConfirmScreen.questions) ...[
                _QuestionBlock(
                  question: q,
                  selected: _answers[q.id],
                  onSelected: (a) => setState(() => _answers[q.id] = a),
                ),
                const SizedBox(height: 16),
              ],
              // 固定ルール（赤旗）に該当したときだけ出す固定警告（NFR-04）。
              if (_anyDanger)
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: scheme.errorContainer,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Semantics(
                    liveRegion: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '気になる状態が選ばれています',
                          style: textTheme.titleMedium
                              ?.copyWith(color: scheme.onErrorContainer),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '症状が強い、急に悪くなっている、息が苦しいなどのときは、'
                          'このアプリでの入力より先に、医療機関や救急へご相談ください。'
                          '命に関わるおそれがあるときは119番に電話してください。',
                          style: TextStyle(color: scheme.onErrorContainer),
                        ),
                      ],
                    ),
                  ),
                ),
              if (_anyDanger) const SizedBox(height: 16),
              // 回答にかかわらず常に示す固定案内（緊急を除外しないための安全線）。
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  border: Border.all(color: Theme.of(context).dividerColor),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Text(
                  'この確認の結果にかかわらず、心配なときや急に悪くなったときは、'
                  '医療機関や救急へご相談ください。このアプリは受診の要否を判断しません。',
                ),
              ),
              const SizedBox(height: 16),
              Text(
                _allAnswered
                    ? '回答を確認しました。次の問診へ進めます。'
                    : 'すべての項目にお答えいただくと次へ進めます。',
              ),
              const SizedBox(height: 8),
              const Text('保存・次の画面（symptoms API）はこのデモでは未接続です。'),
              const ElevatedButton(onPressed: null, child: Text('次へ')),
            ],
          ),
        ),
      ),
    );
  }
}

/// 1問＋原則3択（はい／いいえ／わからない）の固定質問ブロック。
class _QuestionBlock extends StatelessWidget {
  const _QuestionBlock({
    required this.question,
    required this.selected,
    required this.onSelected,
  });

  final SafetyQuestion question;
  final SafetyAnswer? selected;
  final ValueChanged<SafetyAnswer> onSelected;

  static const _labels = {
    SafetyAnswer.yes: 'はい',
    SafetyAnswer.no: 'いいえ',
    SafetyAnswer.unknown: 'わからない',
  };

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return RadioGroup<SafetyAnswer>(
      groupValue: selected,
      onChanged: (value) {
        if (value != null) onSelected(value);
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(question.text, style: textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final answer in SafetyAnswer.values)
            RadioListTile<SafetyAnswer>(
              title: Text(_labels[answer]!),
              value: answer,
            ),
        ],
      ),
    );
  }
}
