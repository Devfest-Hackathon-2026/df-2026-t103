import 'package:flutter/material.dart';

/// 検索結果に表示する施設 1 件。すべて架空の表示用データ。
@immutable
class HospitalSearchResult {
  const HospitalSearchResult({
    required this.name,
    required this.address,
    required this.participating,
    this.confirmedOn,
  });

  /// 施設名。
  final String name;

  /// 所在地。
  final String address;

  /// このアプリで問診を受け取れる参加施設かどうか。
  final bool participating;

  /// 運営確認日。参加施設のみ表示する架空の文字列（例: 2026-10-30）。
  final String? confirmedOn;
}

/// 位置情報取得や検索 API に接続しない病院検索（P-030）のプレビュー。
///
/// 位置情報は取得前に OS 権限の同意を都度求める前提で、拒否しても住所・郵便番号
/// の手入力で続けられる（FR-H01）。参加施設には「このアプリで問診を受け取れる」
/// ラベルと運営確認日を表示し、非参加施設は「場所の案内のみ（送信不可）」とする
/// （FR-H03）。送信が診療予約・受診受け入れを意味しないことを明示する。
class HospitalSearchScreen extends StatefulWidget {
  const HospitalSearchScreen({super.key});

  @override
  State<HospitalSearchScreen> createState() => _HospitalSearchScreenState();
}

class _HospitalSearchScreenState extends State<HospitalSearchScreen> {
  final _keywordController = TextEditingController();

  // 架空のサンプル。実在する施設の情報は含めない。
  static const _results = [
    HospitalSearchResult(
      name: 'サンプル中央クリニック',
      address: '東京都千代田区（架空）1-2-3',
      participating: true,
      confirmedOn: '2026-10-30',
    ),
    HospitalSearchResult(
      name: 'サンプル駅前内科',
      address: '東京都新宿区（架空）4-5-6',
      participating: true,
      confirmedOn: '2026-10-22',
    ),
    HospitalSearchResult(
      name: 'サンプル総合病院',
      address: '東京都港区（架空）7-8-9',
      participating: false,
    ),
  ];

  @override
  void dispose() {
    _keywordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('病院検索デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実在する施設の情報は入力しないでください。'),
              const Text('位置情報の取得や検索は、このデモでは行いません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text('受診先をさがす', style: textTheme.titleLarge),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _showLocationNotice,
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    textStyle: const TextStyle(fontSize: 20),
                  ),
                  icon: const Icon(Icons.my_location),
                  label: const Text('現在地からさがす'),
                ),
              ),
              const SizedBox(height: 8),
              const Text('位置情報は、取得する前に毎回おたずねします。許可しない場合は、下の住所や郵便番号で探せます。'),
              const SizedBox(height: 16),
              TextField(
                controller: _keywordController,
                decoration: const InputDecoration(
                  labelText: '住所・郵便番号（手入力）',
                  hintText: '例：東京都千代田区／100-0001',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              const Text('検索ボタンはこのデモでは未接続です。'),
              const ElevatedButton(onPressed: null, child: Text('この住所でさがす')),
              const SizedBox(height: 24),
              Semantics(
                header: true,
                child: Text('検索結果（表示例）', style: textTheme.titleMedium),
              ),
              const SizedBox(height: 8),
              for (final result in _results) _ResultCard(result: result),
              const SizedBox(height: 16),
              const Divider(),
              const Text(
                '問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。',
              ),
              const SizedBox(height: 8),
              const Text(
                '地図情報の「病院」「医師」の表示は、医療法上の認可や診療の可否を保証しません。'
                '必要に応じて公的な施設情報でご確認ください。',
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showLocationNotice() {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('位置情報について'),
        content: const Text(
          '本番ではここで端末の位置情報の利用許可をおたずねします。'
          '許可しない場合でも、住所や郵便番号の手入力で続けられます。'
          'このデモでは位置情報を取得しません。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('閉じる'),
          ),
        ],
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.result});

  final HospitalSearchResult result;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(result.name, style: textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('所在地: ${result.address}'),
            const SizedBox(height: 8),
            if (result.participating) ...[
              const Text('このアプリで問診を受け取れる施設です。'),
              Text('運営確認日: ${result.confirmedOn}'),
              const SizedBox(height: 8),
              const Text('詳細（P-031）はこのデモでは未接続です。'),
              ElevatedButton(
                onPressed: null,
                child: Text('${result.name}を選ぶ'),
              ),
            ] else
              const Text('場所の案内のみ（送信不可）'),
          ],
        ),
      ),
    );
  }
}
