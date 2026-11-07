import 'package:flutter/material.dart';

/// 送信候補の薬剤 1 件。個別に送信可否を選べる（FR-M07）。すべて架空の表示用。
@immutable
class SendMedicationItem {
  const SendMedicationItem({
    required this.name,
    this.selected = true,
  });

  final String name;
  final bool selected;

  SendMedicationItem copyWith({bool? selected}) {
    return SendMedicationItem(name: name, selected: selected ?? this.selected);
  }
}

/// 送信 API に接続しない送信前確認・個別同意（P-032）のプレビュー。
///
/// 送信票・宛先・送信項目・提供目的を明示し（FR-H05）、送信する薬剤を個別に選べる
/// （FR-M07）。送信には要配慮情報の第三者提供についての個別同意を必須とし、同意する
/// まで送信できない（01 §6-2）。実際の送信（deliveries API・Idempotency-Key による
/// 多重送信防止 FR-H06）は未接続。
class SendConfirmScreen extends StatefulWidget {
  const SendConfirmScreen({super.key, this.facilityName = 'サンプル中央クリニック'});

  final String facilityName;

  @override
  State<SendConfirmScreen> createState() => _SendConfirmScreenState();
}

class _SendConfirmScreenState extends State<SendConfirmScreen> {
  // 架空のサンプル。実際の処方情報は含めない。
  final List<SendMedicationItem> _medications = [
    const SendMedicationItem(name: 'サンプル降圧薬'),
    const SendMedicationItem(name: 'サンプル胃薬'),
  ];
  bool _includePhoto = true;
  bool _consented = false;

  bool get _canSend => _consented;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('送信前の確認デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実際の内容は送信されません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text('送信の前に確認してください', style: textTheme.titleLarge),
              ),
              const SizedBox(height: 16),
              _section(textTheme, '送信先', [Text(widget.facilityName)]),
              _section(textTheme, '送信する内容', [
                const Text('・問診票（あなたの回答の要約）'),
                Text(_includePhoto ? '・処方箋の写真（含む）' : '・処方箋の写真（含まない）'),
                const Text('・下で選んだお薬'),
              ]),
              CheckboxListTile(
                title: const Text('処方箋の写真を含める'),
                value: _includePhoto,
                onChanged: (value) =>
                    setState(() => _includePhoto = value ?? false),
              ),
              _section(textTheme, '送信するお薬を選ぶ', [
                for (final medication in _medications)
                  CheckboxListTile(
                    title: Text(medication.name),
                    value: medication.selected,
                    onChanged: (value) => _toggleMedication(medication, value),
                  ),
              ]),
              _section(textTheme, '提供する目的', [
                const Text('選んだ医療機関に、あなたの問診内容を伝えるために送信します。'),
              ]),
              const SizedBox(height: 8),
              CheckboxListTile(
                title: const Text(
                  '上記の内容を、この医療機関に送信することに同意します（必須）。',
                ),
                subtitle: const Text('症状やお薬などの情報を、この医療機関に提供することへの同意です。'),
                value: _consented,
                onChanged: (value) =>
                    setState(() => _consented = value ?? false),
              ),
              const SizedBox(height: 8),
              Text(
                _canSend ? '送信できます。' : '同意すると送信できます。',
              ),
              const SizedBox(height: 8),
              const Text('実際の送信はこのデモでは行いません。'),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _canSend ? _send : null,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    textStyle: const TextStyle(fontSize: 20),
                  ),
                  child: const Text('この内容で送信する'),
                ),
              ),
              const SizedBox(height: 16),
              const Divider(),
              const Text(
                '問診票の送信は、診療予約・医師の確認・受診の受け入れを意味しません。',
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _section(TextTheme textTheme, String title, List<Widget> children) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: textTheme.titleMedium),
          const SizedBox(height: 8),
          ...children,
        ],
      ),
    );
  }

  void _toggleMedication(SendMedicationItem medication, bool? value) {
    final index = _medications.indexOf(medication);
    if (index < 0) return;
    setState(
      () => _medications[index] = medication.copyWith(selected: value ?? false),
    );
  }

  void _send() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('（デモ）送信は行いません。')),
    );
  }
}
