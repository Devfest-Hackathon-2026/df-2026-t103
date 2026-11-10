import 'package:flutter/material.dart';

/// 要約項目の状態。未回答と推測を区別して表示する（FR-I11）。
enum ReviewItemStatus { answered, unanswered, inferred }

/// 問診票レビューの 1 項目。すべて架空の表示用データ。
@immutable
class ReviewItem {
  const ReviewItem({
    required this.label,
    required this.value,
    this.status = ReviewItemStatus.answered,
  });

  final String label;
  final String value;
  final ReviewItemStatus status;
}

/// summary / finalize API に接続しない問診票レビュー＋確定（P-014/P-015）の
/// プレビュー。
///
/// 回答要約を表示し、未回答は「未確認／未回答」、推測は「（推定）」として区別する
/// （FR-I07/I11）。医学的な断定は付け足さない。確定するまで送信できず、確定後は
/// 内容を変更できない（FR-I08）。summary/finalize/送信（P-030）API は未接続。
class ReviewScreen extends StatefulWidget {
  const ReviewScreen({super.key});

  @override
  State<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends State<ReviewScreen> {
  // 架空のサンプル（docs/03 §3.6 の例に準拠）。医学的な判断は含めない。
  static const _items = [
    ReviewItem(label: '主な症状', value: '夕方になると体がだるい'),
    ReviewItem(label: 'いつから', value: '2週間ほど前'),
    ReviewItem(label: '頻度', value: '日によって異なる'),
    ReviewItem(
      label: '痛む場所',
      value: '未確認／未回答',
      status: ReviewItemStatus.unanswered,
    ),
    ReviewItem(
      label: '生活への影響',
      value: '仕事に集中しづらい',
      status: ReviewItemStatus.inferred,
    ),
    ReviewItem(label: '持病', value: '高血圧、変形性膝関節症（本人登録）'),
    ReviewItem(label: '飲んでいる薬', value: '1件（本人確認済）'),
    ReviewItem(label: '分からなかったこと', value: '疲労感の強さ'),
  ];

  bool _finalized = false;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('問診票の確認デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです（合成データ）。実際の問診内容は含みません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text(
                  _finalized ? '確定した問診票' : '問診票の確認',
                  style: textTheme.titleLarge,
                ),
              ),
              if (_finalized) ...[
                const SizedBox(height: 8),
                const Text('この内容は確定済みで、変更できません。'),
              ],
              const SizedBox(height: 16),
              for (final item in _items)
                _ReviewCard(
                  item: item,
                  editable: !_finalized,
                  onEdit: () => _edit(item),
                ),
              const SizedBox(height: 16),
              if (!_finalized) ...[
                const Text('内容が正しければ確定してください。確定すると変更できません。'),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _finalize,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      textStyle: const TextStyle(fontSize: 20),
                    ),
                    child: const Text('この内容で確定する'),
                  ),
                ),
              ] else ...[
                const Text('病院検索（P-030）はこのデモでは未接続です。'),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: null,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      textStyle: const TextStyle(fontSize: 20),
                    ),
                    child: const Text('送信先をさがす'),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _edit(ReviewItem item) async {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('（デモ）「${item.label}」の修正画面へ戻ります。')),
    );
  }

  Future<void> _finalize() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('確定の確認'),
        content: const Text('確定すると、この問診票の内容は変更できなくなります。よろしいですか？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('やめる'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('確定する'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _finalized = true);
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({
    required this.item,
    required this.editable,
    required this.onEdit,
  });

  final ReviewItem item;
  final bool editable;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final isUnanswered = item.status == ReviewItemStatus.unanswered;
    final isInferred = item.status == ReviewItemStatus.inferred;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(item.label, style: textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(isInferred ? '（推定）${item.value}' : item.value),
            if (isInferred) const Text('※ あなたの回答から推定した内容です。'),
            if (isUnanswered) const Text('※ まだ回答がありません。'),
            if (editable) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: onEdit,
                  style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                  icon: const Icon(Icons.edit),
                  label: const Text('この項目を直す'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
