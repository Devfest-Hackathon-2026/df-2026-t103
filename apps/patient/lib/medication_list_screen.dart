import 'package:flutter/material.dart';

/// 服薬状況の区分。
enum MedicationStatus { current, past, unknown }

/// 登録元。確認日とあわせて一覧に明示する（FR-M05）。
enum MedicationSource { manual, photo }

String medicationStatusLabel(MedicationStatus status) => switch (status) {
  MedicationStatus.current => '服用中',
  MedicationStatus.past => '過去に服用',
  MedicationStatus.unknown => '不明',
};

String medicationSourceLabel(MedicationSource source) => switch (source) {
  MedicationSource.manual => '手入力',
  MedicationSource.photo => '写真から',
};

/// 一覧に表示する薬剤 1 件。すべてメモリ上のみで保持し、保存も送信もしない。
@immutable
class MedicationEntry {
  const MedicationEntry({
    required this.name,
    required this.status,
    required this.source,
    required this.confirmedOn,
  });

  final String name;
  final MedicationStatus status;
  final MedicationSource source;

  /// 確認日。架空の表示用文字列（例: 2026-11-01）。
  final String confirmedOn;

  MedicationEntry copyWith({
    String? name,
    MedicationStatus? status,
  }) {
    return MedicationEntry(
      name: name ?? this.name,
      status: status ?? this.status,
      source: source,
      confirmedOn: confirmedOn,
    );
  }
}

/// 保存や送信、API 接続を行わない薬剤一覧（P-020）のプレビュー。
///
/// 現在・過去・不明の薬剤を、服薬状況・登録元・確認日とともに表示する。
/// 編集・削除はメモリ上の一覧にのみ反映する。追加導線（P-021 処方箋撮影）は
/// 未接続のため、導線だけを示す。
class MedicationListScreen extends StatefulWidget {
  const MedicationListScreen({super.key});

  @override
  State<MedicationListScreen> createState() => _MedicationListScreenState();
}

class _MedicationListScreenState extends State<MedicationListScreen> {
  // 架空のサンプル。実際の患者情報は含めない。
  final List<MedicationEntry> _medications = [
    const MedicationEntry(
      name: 'サンプル降圧薬',
      status: MedicationStatus.current,
      source: MedicationSource.manual,
      confirmedOn: '2026-11-01',
    ),
    const MedicationEntry(
      name: 'サンプル胃薬',
      status: MedicationStatus.past,
      source: MedicationSource.photo,
      confirmedOn: '2026-10-15',
    ),
    const MedicationEntry(
      name: 'サンプル市販のかぜ薬',
      status: MedicationStatus.unknown,
      source: MedicationSource.manual,
      confirmedOn: '2026-10-28',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('薬の一覧デモ')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('架空のデモです。実際の薬の情報は入力しないでください。'),
              const Text('一覧はメモリ上のみで、保存も送信もされません。'),
              const SizedBox(height: 16),
              Semantics(
                header: true,
                child: Text(
                  'お薬の一覧（${_medications.length}件）',
                  style: textTheme.titleLarge,
                ),
              ),
              const SizedBox(height: 16),
              if (_medications.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Text('登録されているお薬はありません。'),
                )
              else
                for (final medication in _medications)
                  _MedicationCard(
                    medication: medication,
                    onEdit: () => _edit(medication),
                    onDelete: () => _delete(medication),
                  ),
              const SizedBox(height: 16),
              const Text('お薬は現在・過去・不明に分けて、登録元と確認日を表示しています。'),
              const SizedBox(height: 16),
              const Text('追加（P-021 処方箋の撮影）は、このデモでは未接続です。'),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: null,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    textStyle: const TextStyle(fontSize: 20),
                  ),
                  icon: const Icon(Icons.add),
                  label: const Text('お薬を追加（写真から）'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _edit(MedicationEntry medication) async {
    final index = _medications.indexOf(medication);
    if (index < 0) return;
    final updated = await showDialog<MedicationEntry>(
      context: context,
      builder: (context) => _EditMedicationDialog(medication: medication),
    );
    if (updated == null || !mounted) return;
    setState(() => _medications[index] = updated);
  }

  Future<void> _delete(MedicationEntry medication) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('削除の確認'),
        content: Text('「${medication.name}」を一覧から削除しますか？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('やめる'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('削除する'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _medications.remove(medication));
  }
}

class _MedicationCard extends StatelessWidget {
  const _MedicationCard({
    required this.medication,
    required this.onEdit,
    required this.onDelete,
  });

  final MedicationEntry medication;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

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
            Text(medication.name, style: textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('服薬状況: ${medicationStatusLabel(medication.status)}'),
            Text('登録元: ${medicationSourceLabel(medication.source)}'),
            Text('確認日: ${medication.confirmedOn}'),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Semantics(
                  button: true,
                  label: '${medication.name}を編集',
                  child: TextButton.icon(
                    onPressed: onEdit,
                    style: TextButton.styleFrom(
                      minimumSize: const Size(48, 48),
                    ),
                    icon: const Icon(Icons.edit),
                    label: const Text('編集'),
                  ),
                ),
                const SizedBox(width: 8),
                Semantics(
                  button: true,
                  label: '${medication.name}を削除',
                  child: TextButton.icon(
                    onPressed: onDelete,
                    style: TextButton.styleFrom(
                      minimumSize: const Size(48, 48),
                    ),
                    icon: const Icon(Icons.delete_outline),
                    label: const Text('削除'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _EditMedicationDialog extends StatefulWidget {
  const _EditMedicationDialog({required this.medication});

  final MedicationEntry medication;

  @override
  State<_EditMedicationDialog> createState() => _EditMedicationDialogState();
}

class _EditMedicationDialogState extends State<_EditMedicationDialog> {
  late final TextEditingController _nameController =
      TextEditingController(text: widget.medication.name);
  late MedicationStatus _status = widget.medication.status;

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('お薬の編集'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _nameController,
              maxLength: 100,
              decoration: const InputDecoration(
                labelText: 'お薬の名前',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            const Text('服薬状況'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                for (final status in MedicationStatus.values)
                  ChoiceChip(
                    label: Text(medicationStatusLabel(status)),
                    selected: _status == status,
                    onSelected: (_) => setState(() => _status = status),
                  ),
              ],
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('やめる'),
        ),
        TextButton(
          onPressed: () {
            final name = _nameController.text.trim();
            if (name.isEmpty) return;
            Navigator.of(context).pop(
              widget.medication.copyWith(name: name, status: _status),
            );
          },
          child: const Text('保存'),
        ),
      ],
    );
  }
}
