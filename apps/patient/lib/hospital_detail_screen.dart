import 'package:flutter/material.dart';

/// 病院詳細に表示する施設情報。すべて架空の表示用データ。
@immutable
class HospitalDetail {
  const HospitalDetail({
    required this.name,
    required this.address,
    required this.participating,
    this.confirmedOn,
  });

  /// 施設名。
  final String name;

  /// 所在地。
  final String address;

  /// このアプリで問診を受け取れる参加施設かどうか（＝送信可否）。
  final bool participating;

  /// 運営確認日。参加施設のみ表示する架空の文字列（例: 2026-10-30）。
  final String? confirmedOn;

  /// 参加施設だけが問診票を送信できる（FR-H05/BR-11）。
  bool get canSend => participating;
}

/// 送信 API に接続しない病院詳細（P-031）のプレビュー。
///
/// 名称・所在地・参加状況・送信可否を表示し、送信できるのは参加施設のみ
/// （非参加施設は「場所の案内のみ（送信不可）」）。地図サービス由来の情報には
/// 帰属表示を添える（RISK-06 / S10）。送信（P-032）は未接続。
class HospitalDetailScreen extends StatelessWidget {
  const HospitalDetailScreen({super.key, this.detail = _sample});

  final HospitalDetail detail;

  static const _sample = HospitalDetail(
    name: 'サンプル中央クリニック',
    address: '東京都千代田区（架空）1-2-3',
    participating: true,
    confirmedOn: '2026-10-30',
  );

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('病院詳細デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実在する施設の情報は含みません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text(detail.name, style: textTheme.titleLarge),
              ),
              const SizedBox(height: 16),
              Text('所在地: ${detail.address}'),
              const SizedBox(height: 16),
              if (detail.participating) ...[
                const Text('このアプリで問診を受け取れる施設です。'),
                Text('運営確認日: ${detail.confirmedOn}'),
              ] else
                const Text('この施設は、このアプリでは問診を送信できません。場所の案内のみです。'),
              const SizedBox(height: 24),
              if (detail.canSend) ...[
                const Text('送信（P-032）はこのデモでは未接続です。'),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: null,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(48, 48),
                      textStyle: const TextStyle(fontSize: 20),
                    ),
                    child: const Text('この施設へ送信へ進む'),
                  ),
                ),
              ] else
                const Text('送信不可（場所の案内のみ）'),
              const SizedBox(height: 24),
              const Divider(),
              const Text(
                '問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。',
              ),
              const SizedBox(height: 8),
              // RISK-06 / S10: 地図サービス由来情報の帰属表示。
              const Text('施設情報の一部は地図サービス（Google）に基づく場合があります。'),
              const Text('Powered by Google'),
            ],
          ),
        ),
      ),
    );
  }
}
