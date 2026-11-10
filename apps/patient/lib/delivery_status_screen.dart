import 'package:flutter/material.dart';

/// 実際の送信結果ではなく、プレビューに表示する架空の状態。
enum DemoDeliveryStatus { created, delivered, acknowledged, failed }

class DeliveryStatusScreen extends StatelessWidget {
  const DeliveryStatusScreen({
    super.key,
    required this.status,
    required this.onStatusChanged,
  });

  final DemoDeliveryStatus status;
  final ValueChanged<DemoDeliveryStatus> onStatusChanged;

  @override
  Widget build(BuildContext context) {
    final (title, description) = switch (status) {
      DemoDeliveryStatus.created => (
        '受付済み',
        '送信を受け付けた状態のサンプルです。まだ配送済みではありません。',
      ),
      DemoDeliveryStatus.delivered => (
        '配送済み',
        '施設の受信箱に反映された状態のサンプルです。施設が確認したことは示しません。',
      ),
      DemoDeliveryStatus.acknowledged => (
        '施設確認',
        '施設が確認した状態のサンプルです。医師が確認したことは示しません。',
      ),
      DemoDeliveryStatus.failed => ('失敗', '送信の処理に失敗した状態のサンプルです。配送されたことは示しません。'),
    };

    return Scaffold(
      appBar: AppBar(title: const Text('送信結果デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('架空サンプル', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              const Text('表示は架空の状態です。実際の送信・配送や状況確認は行いません。'),
              const SizedBox(height: 24),
              Text(
                'サンプルの状態：$title',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(description),
              const SizedBox(height: 16),
              const Text('問診票の送信は、診察や予約の確定、医師の確認、受診の受入れを意味しません。'),
              const SizedBox(height: 24),
              Text(
                '架空の状態を切り替える',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              for (final (sample, label) in [
                (DemoDeliveryStatus.created, '受付済み'),
                (DemoDeliveryStatus.delivered, '配送済み'),
                (DemoDeliveryStatus.acknowledged, '施設確認'),
                (DemoDeliveryStatus.failed, '失敗'),
              ])
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: OutlinedButton(
                    onPressed: () => onStatusChanged(sample),
                    child: Text('サンプル：$label'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
